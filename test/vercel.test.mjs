// Vercel-mode harness: runs the api/*.mjs default exports behind a tiny router that
// mirrors vercel.json rewrites and the middleware, with Comfy Cloud mocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hashPassword } from "../lib/accounts.mjs";
import { route } from "../lib/edge.mjs";
import { userFromHeaders } from "../lib/session.mjs";

const PASSWORD = "harness-password-0123456789";
const FAKE_KEY = "fake-key-SENTINEL-not-real";
process.env.VERCEL = "1";
process.env.SESSION_SECRET = "harness-secret-0123456789abcdef0123456789";
process.env.JUDGE_ACCOUNTS = Buffer.from(JSON.stringify({ judge9: hashPassword(PASSWORD) })).toString("base64");
process.env.COMFY_CLOUD_API_KEY = FAKE_KEY;
process.env.COMFY_DEPLOYMENT_ENDPOINT = "https://comfy.invalid";

const realFetch = globalThis.fetch;
const comfyCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.startsWith("https://comfy.invalid")) return realFetch(url, init);
  comfyCalls.push(href);
  if (href.endsWith("/api/v2/assets")) return Response.json({ name: "shot-1.jpg" }, { status: 201 });
  if (href.endsWith("/api/v2/jobs")) return Response.json({ id: "job_1" }, { status: 201 });
  if (href.includes("/api/v2/jobs/job_1")) {
    return Response.json({ id: "job_1", status: "completed", outputs: [{ node_id: "75", type: "video", url: "/out.mp4" }] });
  }
  if (href.endsWith("/out.mp4")) return new Response(Buffer.alloc(6 * 1024 * 1024, 7), { headers: { "content-type": "video/mp4" } });
  return new Response("nope", { status: 404 });
};

const handlers = {
  "/api/login": (await import("../api/login.mjs")).default,
  "/api/logout": (await import("../api/logout.mjs")).default,
  "/api/page": (await import("../api/page.mjs")).default,
  "/api/health": (await import("../api/health.mjs")).default,
  "/api/upload": (await import("../api/upload.mjs")).default,
  "/api/submit": (await import("../api/submit.mjs")).default,
  "/api/status": (await import("../api/status.mjs")).default,
  "/api/file": (await import("../api/file.mjs")).default,
};
const REWRITES = { "/login": "/api/login", "/logout": "/api/logout" };

let server;
let base;
before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const decision = route({ method: req.method, pathname: url.pathname, user: userFromHeaders(req.headers) });
    if (decision.type === "redirect") { res.writeHead(302, { Location: decision.to }); res.end(); return; }
    if (decision.type === "status") { res.writeHead(decision.status); res.end(decision.body); return; }
    let target = decision.type === "rewrite" ? decision.to : url.pathname;
    target = REWRITES[target] || target;
    const fn = handlers[target];
    if (!fn) { res.writeHead(200); res.end("static"); return; }
    await fn(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

function login(password) {
  return realFetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "judge9", password }),
    redirect: "manual",
  });
}

test("vercel: login page, bad and good login, gated page, logout", async () => {
  const home = await realFetch(`${base}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/login");
  const page = await realFetch(`${base}/login`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Judges access/);
  assert.match(html, /Judges only/);
  assert.equal(/Grok/i.test(html), false);

  const bad = await login("wrong-password");
  assert.equal(bad.status, 401);
  assert.equal((bad.headers.getSetCookie?.() ?? []).length, 0);

  const good = await login(PASSWORD);
  assert.equal(good.status, 303);
  const line = good.headers.getSetCookie()[0];
  assert.match(line, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800/);
  const cookie = line.split(";")[0];

  const index = await realFetch(`${base}/`, { headers: { cookie } });
  assert.equal(index.status, 200);
  const body = await index.text();
  assert.match(body, /class="mast-judge">judge9</);
  assert.equal(body.includes("{{judge}}"), false);

  const health = await realFetch(`${base}/api/health`, { headers: { cookie } });
  assert.equal(health.status, 200);

  const out = await realFetch(`${base}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
  assert.equal(out.status, 303);
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
});

test("vercel: api requires a session even if middleware is bypassed", async () => {
  for (const p of ["/api/health", "/api/status?id=job_1", "/api/file?id=job_1"]) {
    const res = await realFetch(`${base}${p}`);
    assert.equal(res.status, 401, p);
  }
  const direct = await handlers["/api/upload"];
  assert.equal(typeof direct, "function");
});

test("vercel: upload limit, render flow, streamed clip, key never echoed", async () => {
  const res = await login(PASSWORD);
  const cookie = res.headers.getSetCookie()[0].split(";")[0];
  const big = await realFetch(`${base}/api/upload`, {
    method: "POST",
    headers: { cookie, "content-type": "image/jpeg" },
    body: Buffer.alloc(4.5 * 1024 * 1024, 1),
  });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /too large after resizing/);

  const up = await realFetch(`${base}/api/upload`, {
    method: "POST",
    headers: { cookie, "content-type": "image/jpeg", "x-filename": "shot-1.jpg" },
    body: Buffer.alloc(3 * 1024 * 1024, 1),
  });
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { name: "shot-1.jpg" });

  const sub = await realFetch(`${base}/api/submit`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ image: "shot-1.jpg", look: "film", brief: "test", seed: 3, duration: 2 }),
  });
  const subText = await sub.text();
  assert.equal(subText.includes(FAKE_KEY), false);
  assert.equal(sub.status, 200, subText);
  assert.deepEqual(JSON.parse(subText), { id: "job_1" });
  assert.ok(comfyCalls.some((c) => c.endsWith("/api/v2/jobs")));

  const status = await realFetch(`${base}/api/status?id=job_1`, { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).ready, true);

  const clip = await realFetch(`${base}/api/file?id=job_1`, { headers: { cookie } });
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-length"), null);
  assert.equal(clip.headers.get("content-type"), "video/mp4");
  assert.equal((await clip.arrayBuffer()).byteLength, 6 * 1024 * 1024);
});
