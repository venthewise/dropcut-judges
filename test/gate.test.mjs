import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createApp,
  HOST,
  PORT,
  freshFailures,
  RATE_WINDOW_MS,
  MAX_FAILURES,
} from "../server.mjs";
import { loadJudges, passwordMatches, JUDGES_PATH, CREDENTIALS_PATH } from "../lib/accounts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function credentialFor(username) {
  const text = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    if (line.slice(0, tab) === username) found = line.slice(tab + 1);
  }
  if (!found) throw new Error(`Missing credentials for ${username}. Run: node scripts/add-judge.mjs ${username}`);
  return found;
}

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(0, HOST, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  try {
    assert.equal(address.address, HOST);
    await fn(`http://${HOST}:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function postLogin(base, username, password) {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
}

function sessionPair(res) {
  const lines = res.headers.getSetCookie?.() ?? [];
  const line = lines.find((item) => item.toLowerCase().startsWith("session="));
  assert.ok(line, "missing session cookie");
  assert.match(line, /HttpOnly/);
  assert.match(line, /SameSite=Lax/);
  assert.match(line, /Path=\//);
  assert.match(line, /Max-Age=28800/);
  assert.equal(/;\s*Secure/i.test(line), false);
  const token = line.split(";")[0].slice("session=".length);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  return line.split(";")[0];
}

let tail = Promise.resolve();
function step(name, fn) {
  test(name, { timeout: 60_000 }, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

step("plaintext password is never stored in judges.json", () => {
  const password = credentialFor("judge1");
  const raw = fs.readFileSync(JUDGES_PATH, "utf8");
  assert.equal(raw.includes(password), false);
  assert.equal(raw.includes("password"), false);
  const data = JSON.parse(raw);
  const record = data.judge1;
  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), ["hash", "salt"]);
  assert.match(record.salt, /^[0-9a-f]{32}$/);
  assert.match(record.hash, /^[0-9a-f]{128}$/);
  assert.equal(passwordMatches(password, record), true);
  assert.equal(passwordMatches("wrong-password", record), false);
  assert.equal(passwordMatches(password, null), false);
  assert.equal(passwordMatches(password, { salt: "aa", hash: "bb" }), false);
  for (const line of fs.readFileSync(CREDENTIALS_PATH, "utf8").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab === -1 || line.startsWith("#")) continue;
    assert.equal(raw.includes(line.slice(tab + 1)), false);
  }
  const loaded = loadJudges();
  assert.equal(loaded.judge1.hash, record.hash);
  assert.equal(loaded.judge1.salt, record.salt);
});

step("failed attempts expire after 15 minutes", () => {
  assert.equal(RATE_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(MAX_FAILURES, 5);
  const now = 10_000_000;
  assert.equal(freshFailures(Array(5).fill(now - 1000), now).length, 5);
  assert.equal(freshFailures(Array(5).fill(now - RATE_WINDOW_MS), now).length, 0);
  assert.equal(freshFailures([now - (RATE_WINDOW_MS - 1)], now).length, 1);
});

step("listen constants are the loopback port", () => {
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 5180);
});

step("redirects to /login when signed out", async () => {
  await withServer(async (base) => {
    const index = await fetch(`${base}/index.html`, { redirect: "manual" });
    assert.equal(index.status, 302);
    assert.equal(index.headers.get("location"), "/login");
    await index.arrayBuffer();

    const login = await fetch(`${base}/login`, { redirect: "manual" });
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.match(html, /<h1>Judges access<\/h1>/);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password"/);
    assert.equal(html.includes("Unknown username or password."), false);

    const favicon = await fetch(`${base}/favicon`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /image\/png/);
    const icon = Buffer.from(await favicon.arrayBuffer());
    const disk = fs.readFileSync(path.join(root, "media", "icon.png"));
    assert.deepEqual(icon.subarray(0, 16), disk.subarray(0, 16));
  });
});

step("anonymous / shows the user and judge landing", async () => {
  await withServer(async (base) => {
    const home = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("location"), null);
    assert.match(home.headers.get("content-type") || "", /text\/html/);
    const html = await home.text();
    assert.match(html, />USER</);
    assert.match(html, />JUDGE</);
    assert.match(html, /href="https:\/\/github.com\/venthewise\/dropcut-judges"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener"/);
    assert.match(html, /Check out the github repo!/);
    assert.match(html, /href="\/login"/);
    assert.equal(html.includes("js-generate"), false);
    assert.equal(/<script/i.test(html), false);
  });
});

step("returns 401 for media when signed out", async () => {
  await withServer(async (base) => {
    for (const asset of ["/media/listing.mp4", "/media/song.m4a", "/media/logo.webp", "/app.js", "/styles.css", "/data.js"]) {
      const res = await fetch(`${base}${asset}`, { redirect: "manual" });
      assert.equal(res.status, 401, asset);
      assert.equal(res.headers.get("location"), null);
      const body = await res.text();
      assert.equal(body, "Unauthorized");
    }
  });
});

step("rejects a bad password", async () => {
  await withServer(async (base) => {
    const res = await postLogin(base, "judge1", "not-the-password");
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /Unknown username or password\./);
    assert.match(html, /Judges access/);
    assert.equal(html.includes("not-the-password"), false);
    const lines = res.headers.getSetCookie?.() ?? [];
    assert.equal(lines.some((line) => /^session=[^;]+/.test(line)), false);

    const home = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("location"), null);
    const homeHtml = await home.text();
    assert.equal(homeHtml.includes("js-generate"), false);
  });
});

step("accepts a good login", async () => {
  const password = credentialFor("judge1");
  await withServer(async (base) => {
    const res = await postLogin(base, "judge1", password);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    await res.arrayBuffer();
    const cookie = sessionPair(res);

    const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(home.status, 200);
    const html = await home.text();
    const disk = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.equal(html, disk.replaceAll("{{judge}}", "judge1"));
    assert.match(html, /class="mast-judge">judge1</);
    assert.match(html, /Sign out/);
    assert.match(html, /action="\/logout"/);
    assert.match(html, /js-generate/);
    assert.match(html, /js-wave/);
    assert.match(html, /js-download/);
    assert.match(html, /data-preset="cafe"/);
    assert.match(html, /data-preset="gig"/);
    assert.match(html, /data-preset="listing"/);

    for (const file of ["app.js", "data.js", "styles.css"]) {
      const served = await fetch(`${base}/${file}`, { headers: { cookie } });
      assert.equal(served.status, 200, file);
      assert.equal(await served.text(), fs.readFileSync(path.join(root, file), "utf8"));
    }

    const song = await fetch(`${base}/media/song.m4a`, {
      headers: { cookie, range: "bytes=0-15" },
    });
    assert.equal(song.status, 206);
    assert.equal(song.headers.get("content-type"), "audio/mp4");
    const songBytes = Buffer.from(await song.arrayBuffer());
    assert.deepEqual(songBytes, fs.readFileSync(path.join(root, "media", "song.m4a")).subarray(0, 16));

    const reel = await fetch(`${base}/media/listing.mp4`, {
      headers: { cookie, range: "bytes=0-15" },
    });
    assert.equal(reel.status, 206);
    assert.equal(reel.headers.get("content-type"), "video/mp4");
    await reel.arrayBuffer();

    for (const secret of ["/judges.json", "/judges-credentials.txt", "/server.mjs", "/.env"]) {
      const hidden = await fetch(`${base}${secret}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(hidden.status, 404, secret);
      const body = await hidden.text();
      assert.equal(body.includes(password), false);
    }

    const login = await fetch(`${base}/login`, { headers: { cookie }, redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    await login.arrayBuffer();
  });
});

step("logout ends the session", async () => {
  const password = credentialFor("judge1");
  await withServer(async (base) => {
    const login = await postLogin(base, "judge1", password);
    assert.equal(login.status, 303);
    const cookie = sessionPair(login);
    await login.arrayBuffer();

    const out = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/login");
    await out.arrayBuffer();

    const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("location"), null);
    const homeHtml = await home.text();
    assert.match(homeHtml, /Check out the github repo!/);
    assert.equal(homeHtml.includes("js-generate"), false);
    assert.equal(homeHtml.includes("mast-judge"), false);

    const media = await fetch(`${base}/media/listing.mp4`, { headers: { cookie }, redirect: "manual" });
    assert.equal(media.status, 401);
    await media.arrayBuffer();
  });
});

step("rate limit triggers after 5 failures", async () => {
  const password = credentialFor("judge1");
  await withServer(async (base) => {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await postLogin(base, "judge1", "not-the-password");
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401]);

    const blocked = await postLogin(base, "judge1", password);
    assert.equal(blocked.status, 429);
    const html = await blocked.text();
    assert.match(html, /Too many attempts/);
    const lines = blocked.headers.getSetCookie?.() ?? [];
    assert.equal(lines.some((line) => /^session=[^;]+/.test(line)), false);

    const home = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("location"), null);
    const homeHtml = await home.text();
    assert.equal(homeHtml.includes("js-generate"), false);
  });
});

step("server binds to 127.0.0.1:5180 only", async () => {
  const password = credentialFor("judge1");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (buf) => { stdout += buf; });
  child.stderr.on("data", (buf) => { stderr += buf; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  try {
    const started = Date.now();
    let up = false;
    while (Date.now() - started < 8000) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://${HOST}:${PORT}/login`);
        const html = await res.text();
        if (res.status === 200 && html.includes("Judges access")) {
          up = true;
          break;
        }
      } catch {
        // Port not open yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(up, true, stderr || stdout || "server did not start");
    assert.match(stdout, /127\.0\.0\.1:5180/);
    assert.equal(stdout.includes(password), false);
    assert.equal(stderr.includes(password), false);

    const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const lines = netstat.split(/\r?\n/).filter((line) => line.includes(":5180"));
    assert.ok(lines.some((line) => line.includes("127.0.0.1:5180")));
    assert.equal(lines.some((line) => line.includes("0.0.0.0:5180") || line.includes("[::]:5180")), false);

    const media = await fetch(`http://${HOST}:${PORT}/media/listing.mp4`, { redirect: "manual" });
    assert.equal(media.status, 401);
    await media.arrayBuffer();
  } finally {
    await stop();
  }
});
