import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, HOST } from "../server.mjs";
import { CREDENTIALS_PATH } from "../lib/accounts.mjs";
import { parseEnv } from "../lib/env.mjs";
import { buildCutList, seedFor, analyzeWindow } from "../lib/cuts.mjs";
import { createGate, createRuntime } from "../lib/runtime.mjs";
import {
  ASPECT,
  FPS,
  LOOKS,
  assetName,
  composePositive,
  findOutput,
  loadWorkflowFiles,
  patchWorkflow,
  renderDuration,
} from "../lib/workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "SENTINEL-DO-NOT-LEAK";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function credentialFor(username) {
  const text = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab !== -1 && line.slice(0, tab) === username) return line.slice(tab + 1);
  }
  throw new Error(`Missing credentials for ${username}`);
}

async function withServer(options, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href.startsWith("http://127.0.0.1:") || href.startsWith("http://localhost:")) {
      return original(url, init);
    }
    throw new Error("outbound fetch");
  };
  const server = createApp(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();
  const logs = [];
  const methods = ["log", "error", "warn", "info"];
  const previous = {};
  for (const method of methods) {
    previous[method] = console[method];
    console[method] = (...args) => {
      logs.push(args.map((part) => String(part)).join(" "));
    };
  }
  try {
    await fn(`http://${HOST}:${port}`, logs);
  } finally {
    for (const method of methods) console[method] = previous[method];
    globalThis.fetch = original;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function noSecret(value, label) {
  assert.equal(String(value).includes(SENTINEL), false, label);
}

async function login(base) {
  const password = credentialFor("judge1");
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "judge1", password }),
    redirect: "manual",
  });
  assert.equal(res.status, 303);
  const line = (res.headers.getSetCookie?.() ?? []).find((item) => item.startsWith("session="));
  assert.ok(line);
  await res.arrayBuffer();
  noSecret(line, "session cookie");
  return line.split(";")[0];
}

function fakeGraph() {
  return {
    img: { inputs: { image: "old" } },
    pos: { inputs: { value: "old" } },
    neg: { inputs: { text: "old" } },
    s1: { inputs: { noise_seed: 1 } },
    s2: { inputs: { noise_seed: 2 } },
    dur: { inputs: { value: 3 } },
    rate: { inputs: { value: 12 } },
    ratio: { inputs: { aspect_ratio: "old" } },
    enh: { inputs: { value: false } },
  };
}

function fakeMap() {
  return {
    fps: FPS,
    aspect: ASPECT,
    durationMinSeconds: 1,
    durationMaxSeconds: 10,
    bindings: {
      image: { nodeId: "img", input: "image" },
      positive: { nodeId: "pos", input: "value" },
      negative: { nodeId: "neg", input: "text" },
      seed: [
        { nodeId: "s1", input: "noise_seed" },
        { nodeId: "s2", input: "noise_seed" },
      ],
      duration: { nodeId: "dur", input: "value" },
      fps: { nodeId: "rate", input: "value" },
      aspect: { nodeId: "ratio", input: "aspect_ratio" },
      enhance: { nodeId: "enh", input: "value" },
      output: { nodeId: "out" },
    },
  };
}

test("workflow patching follows the map", () => {
  const graph = fakeGraph();
  const map = fakeMap();
  const positive = composePositive(LOOKS.neon.positive, "night\nmarket");
  const patched = patchWorkflow(graph, map, {
    image: "shot.png",
    positive,
    negative: LOOKS.neon.negative,
    seed: 11,
    duration: 4.04,
    fps: FPS,
    aspect: ASPECT,
    enhance: false,
  });
  assert.equal(graph.img.inputs.image, "old");
  assert.equal(patched.img.inputs.image, "shot.png");
  assert.equal(patched.pos.inputs.value, `${LOOKS.neon.positive}. Brief: night market. Use the provided start image as the first frame. No text, no black frames.`);
  assert.equal(patched.neg.inputs.text, LOOKS.neon.negative);
  assert.equal(patched.s1.inputs.noise_seed, 11);
  assert.equal(patched.s2.inputs.noise_seed, 11);
  assert.equal(patched.dur.inputs.value, 5);
  assert.equal(patched.rate.inputs.value, 24);
  assert.equal(patched.ratio.inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
  assert.equal(patched.enh.inputs.value, true);
  assert.equal(typeof patched.enh.inputs.value, "boolean");
  assert.deepEqual(
    [renderDuration(0.2), renderDuration(1), renderDuration(1.01), renderDuration(10), renderDuration(10.2), renderDuration(Number.NaN)],
    [1, 1, 2, 10, 10, 1],
  );
});

test("real workflow file is patched from its map", () => {
  const { graph, map } = loadWorkflowFiles(root);
  const before = structuredClone(graph);
  const patched = patchWorkflow(graph, map, {
    image: "frame.webp",
    positive: composePositive(LOOKS.film.positive, "quiet morning"),
    negative: LOOKS.film.negative,
    seed: 42,
    duration: 0.2,
    fps: FPS,
    aspect: ASPECT,
  });
  assert.deepEqual(graph, before);
  const read = (binding) => patched[binding.nodeId].inputs[binding.input];
  assert.equal(read(map.bindings.image), "frame.webp");
  assert.equal(read(map.bindings.positive).includes("quiet morning"), true);
  assert.equal(read(map.bindings.positive).includes(LOOKS.film.positive), true);
  assert.equal(read(map.bindings.negative), LOOKS.film.negative);
  for (const binding of map.bindings.seed) assert.equal(read(binding), 42);
  assert.equal(read(map.bindings.duration), 1);
  assert.equal(read(map.bindings.fps), 24);
  assert.equal(read(map.bindings.aspect), ASPECT);
  assert.equal(read(map.bindings.enhance), true);
  const long = patchWorkflow(graph, map, {
    image: "frame.webp",
    positive: "x",
    negative: "y",
    seed: 1,
    duration: 10.2,
  });
  assert.equal(long[map.bindings.duration.nodeId].inputs[map.bindings.duration.input], 10);
});

test("cut list has one in-bounds segment per photo", () => {
  const beats = [];
  for (let t = 0.5; t < 29; t += 0.5) beats.push(t);
  for (const count of [1, 2, 3, 4, 5]) {
    const result = buildCutList({
      beats,
      duration: 15,
      photoCount: count,
      drop: 6,
      baseSeed: 100,
    });
    assert.equal(result.segments.length, count);
    result.segments.forEach((segment, index) => {
      const ms = Math.round((segment.end - segment.start) * 1000);
      assert.equal(ms >= 350 && ms <= 6500, true, `${count}:${ms}`);
      if (index > 0) {
        assert.equal(Math.round(segment.start * 1000), Math.round(result.segments[index - 1].end * 1000));
      }
      assert.equal(segment.seed, seedFor(100, index));
    });
  }
  const snapped = buildCutList({
    beats: [3, 6, 9, 12],
    duration: 15,
    photoCount: 5,
    drop: 6,
    baseSeed: 7,
  });
  assert.deepEqual(snapped.segments.map((segment) => segment.start), [0, 3, 6, 9, 12]);
  assert.equal(snapped.segments[2].cue, "DROP");
  assert.equal(snapped.segments[2].seed, seedFor(7, 2));

  const wide = buildCutList({ beats, duration: 30, photoCount: 5, baseSeed: 1 });
  assert.equal(wide.segments.length, 5);
  const total = wide.segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  assert.equal(total <= 5 * 6.5 + 0.001, true);
  for (const segment of wide.segments) {
    const ms = Math.round((segment.end - segment.start) * 1000);
    assert.equal(ms >= 350 && ms <= 6500, true);
  }

  const rand = (seed) => {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };
  for (let trial = 1; trial <= 40; trial += 1) {
    const next = rand(trial);
    const count = 1 + Math.floor(next() * 5);
    const duration = 1 + next() * 29;
    const trialBeats = [];
    for (let t = next(); t < duration; t += 0.25 + next()) trialBeats.push(t);
    const result = buildCutList({
      beats: trialBeats,
      duration,
      photoCount: count,
      drop: next() * duration,
      baseSeed: trial,
    });
    assert.equal(result.segments.length, count);
    for (const segment of result.segments) {
      const ms = Math.round((segment.end - segment.start) * 1000);
      assert.equal(ms >= 350 && ms <= 6500, true, `trial ${trial} ${ms}`);
    }
  }

  const sr = 8000;
  const samples = new Float32Array(sr * 4);
  for (let t = 0; t < 4; t += 0.5) samples[Math.floor(t * sr)] = 1;
  const heard = analyzeWindow(samples, sr);
  assert.equal(heard.duration > 3, true);
  assert.equal(Array.isArray(heard.beats), true);
  assert.equal(heard.bpm >= 70 && heard.bpm <= 180, true);
});

test("asset name and save-video output come from the response", () => {
  assert.equal(assetName({ name: " kept.png " }, "fallback.png"), "kept.png");
  assert.equal(assetName({ file_path: "input/shot.webp" }, "fallback.png"), "shot.webp");
  const { map } = loadWorkflowFiles(root);
  const output = findOutput({
    outputs: [
      { node_id: "1", type: "image" },
      { node_id: String(map.bindings.output.nodeId), type: "video", url: "/clip.mp4" },
    ],
  }, map);
  assert.equal(output.url, "/clip.mp4");
  assert.equal(findOutput({ outputs: [{ node_id: "nope", type: "video" }] }, map), null);
});

test("env parser ignores comments and does not require a live renderer", () => {
  assert.deepEqual(parseEnv("# c\nFOO=bar\nBAZ=\"two words\"\n\n=bad\n"), { FOO: "bar", BAZ: "two words" });
  assert.equal(createRuntime({
    env: { COMFY_CLOUD_API_KEY: "", COMFY_DEPLOYMENT_ENDPOINT: "https://example.test" },
  }).offline(), true);
  assert.equal(createRuntime({
    env: { COMFY_CLOUD_API_KEY: SENTINEL, COMFY_DEPLOYMENT_ENDPOINT: "" },
  }).offline(), true);
});

test("at most 2 shots stay in flight", async () => {
  const gate = createGate(2);
  let active = 0;
  let max = 0;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const holders = [0, 1].map(async () => {
    await gate.acquire();
    active += 1;
    max = Math.max(max, active);
    await hold;
    active -= 1;
    gate.release();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(active, 2);
  let third = false;
  const extra = (async () => {
    await gate.acquire();
    third = true;
    active += 1;
    max = Math.max(max, active);
    active -= 1;
    gate.release();
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(third, false);
  release();
  await Promise.all([...holders, extra]);
  assert.equal(third, true);
  assert.equal(max, 2);
});

test("local encoder, font, and cut sheet markup are present", () => {
  const wasm = fs.statSync(path.join(root, "vendor/ffmpeg/ffmpeg-core.wasm")).size;
  const font = fs.statSync(path.join(root, "vendor/fonts/Anton-Regular.ttf")).size;
  assert.equal(wasm > 1_000_000, true);
  assert.equal(font > 10_000, true);
  const license = fs.readFileSync(path.join(root, "vendor/fonts/OFL.txt"), "utf8");
  assert.match(license, /SIL OPEN FONT LICENSE/);
  const worker = fs.readFileSync(path.join(root, "vendor/ffmpeg/814.ffmpeg.js"), "utf8");
  const ffmpegJs = fs.readFileSync(path.join(root, "vendor/ffmpeg/ffmpeg.js"), "utf8");
  assert.equal(worker.includes("unpkg.com"), false);
  assert.equal(ffmpegJs.includes("unpkg.com"), false);
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal(app.includes("unpkg.com"), false);
  assert.equal(app.includes("cdn.jsdelivr.net"), false);
  assert.match(html, /data-source="samples"/);
  assert.match(html, /data-source="real"/);
  assert.match(html, /data-preset="cafe"/);
  assert.match(html, /data-preset="gig"/);
  assert.match(html, /data-preset="listing"/);
  assert.equal(/Grok/i.test(html + app), false);
});

test("api routes return 401 when signed out", async () => {
  await withServer({
    env: { COMFY_CLOUD_API_KEY: "", COMFY_DEPLOYMENT_ENDPOINT: "" },
    fetchImpl: async () => {
      throw new Error("outbound fetch");
    },
  }, async (base) => {
    const routes = [
      ["/api/health", "GET"],
      ["/api/upload", "POST"],
      ["/api/submit", "POST"],
      ["/api/status?id=job", "GET"],
      ["/api/file?id=job", "GET"],
    ];
    for (const [pathname, method] of routes) {
      const res = await fetch(`${base}${pathname}`, { method, redirect: "manual" });
      assert.equal(res.status, 401, pathname);
      assert.equal(await res.text(), "Unauthorized");
    }
  });
});

test("missing env gives the offline error", async () => {
  let called = false;
  await withServer({
    env: { COMFY_CLOUD_API_KEY: "", COMFY_DEPLOYMENT_ENDPOINT: "" },
    fetchImpl: async () => {
      called = true;
      throw new Error("outbound fetch");
    },
  }, async (base, logs) => {
    const cookie = await login(base);
    const headers = { cookie };
    const health = await fetch(`${base}/api/health`, { headers });
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { error: "Renderer is offline" });
    const upload = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { ...headers, "content-type": "image/png", "x-filename": "shot.png" },
      body: PNG,
    });
    assert.equal(upload.status, 503);
    assert.deepEqual(await upload.json(), { error: "Renderer is offline" });
    const submit = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ image: "shot.png", look: "neon", brief: "hi", seed: 1, duration: 2 }),
    });
    assert.equal(submit.status, 503);
    assert.deepEqual(await submit.json(), { error: "Renderer is offline" });
    assert.equal(called, false);
    noSecret(logs.join("\n"), "logs");
    for (const file of ["/vendor/ffmpeg/ffmpeg.js", "/vendor/ffmpeg/814.ffmpeg.js", "/vendor/ffmpeg/ffmpeg-core.js", "/vendor/fonts/Anton-Regular.ttf", "/vendor/fonts/OFL.txt", "/lib/cuts.mjs"]) {
      const hidden = await fetch(`${base}${file}`, { redirect: "manual" });
      assert.equal(hidden.status, 401, file);
      await hidden.arrayBuffer();
      const served = await fetch(`${base}${file}`, { headers: { cookie }, method: "HEAD" });
      assert.equal(served.status, 200, file);
      await served.arrayBuffer();
    }
    const wasm = await fetch(`${base}/vendor/ffmpeg/ffmpeg-core.wasm`, { headers: { cookie }, method: "HEAD" });
    assert.equal(wasm.status, 200);
    assert.match(wasm.headers.get("content-type") || "", /wasm/);
    assert.equal(Number(wasm.headers.get("content-length")) > 1_000_000, true);
  });
});

test("comfy responses are proxied and the key never appears", async () => {
  const { map } = loadWorkflowFiles(root);
  const nodeId = String(map.bindings.output.nodeId);
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const href = String(url);
    calls.push({ href, opts });
    const auth = opts.headers?.Authorization || opts.headers?.authorization || "";
    if (!href.startsWith("https://example.test/")) throw new Error("unexpected host");
    if (href.endsWith("/api/v2/assets") && opts.method === "POST") {
      const form = opts.body;
      assert.equal(typeof form.get, "function");
      assert.ok(form.get("file"));
      assert.equal(form.get("content_type"), "image/png");
      assert.equal(form.get("file_path"), "shot.png");
      return Response.json({ id: "asset-1", name: "shot.png", file_path: "shot.png" }, { status: 201 });
    }
    if (href.endsWith("/api/v2/jobs") && opts.method === "POST") {
      const posted = JSON.parse(opts.body);
      assert.deepEqual(Object.keys(posted), ["workflow"]);
      noSecret(opts.body, "workflow body");
      assert.equal(auth, `Bearer ${SENTINEL}`);
      const read = (binding) => posted.workflow[binding.nodeId].inputs[binding.input];
      assert.equal(read(map.bindings.image), "shot.png");
      assert.equal(read(map.bindings.positive).includes("night market"), true);
      assert.equal(read(map.bindings.positive).includes(LOOKS.ink.positive), true);
      assert.equal(read(map.bindings.negative), LOOKS.ink.negative);
      for (const binding of map.bindings.seed) assert.equal(read(binding), 11);
      assert.equal(read(map.bindings.duration), 4);
      assert.equal(read(map.bindings.fps), 24);
      assert.equal(read(map.bindings.aspect), ASPECT);
      assert.equal(read(map.bindings.enhance), true);
      return Response.json({ id: "job-9", status: "queued", outputs: [] }, { status: 201 });
    }
    if (href.endsWith("/api/v2/jobs/job-9")) {
      return Response.json({
        id: "job-9",
        status: "completed",
        outputs: [{
          node_id: nodeId,
          name: "reel.mp4",
          type: "video",
          content_type: "video/mp4",
          id: "out-1",
          url: "/api/v2/assets/out-1/content",
        }],
      });
    }
    if (href.endsWith("/api/v2/assets/out-1/content")) {
      return new Response(Buffer.from("videobytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }
    throw new Error(`unexpected ${href}`);
  };

  await withServer({
    env: { COMFY_CLOUD_API_KEY: SENTINEL, COMFY_DEPLOYMENT_ENDPOINT: "https://example.test" },
    fetchImpl,
  }, async (base, logs) => {
    const cookie = await login(base);
    const headers = { cookie };
    const health = await fetch(`${base}/api/health`, { headers });
    assert.equal(health.status, 200);
    const healthText = await health.text();
    assert.equal(healthText, "{\"ok\":true}");
    noSecret(healthText, "health");

    const upload = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { ...headers, "content-type": "image/png", "x-filename": "shot.png" },
      body: PNG,
    });
    const uploadText = await upload.text();
    assert.equal(upload.status, 200);
    assert.equal(uploadText, "{\"name\":\"shot.png\"}");
    noSecret(uploadText, "upload");

    const submit = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        image: "shot.png",
        look: "ink",
        brief: "night market",
        seed: 11,
        duration: 3.2,
      }),
    });
    const submitText = await submit.text();
    assert.equal(submit.status, 200);
    assert.equal(submitText, "{\"id\":\"job-9\"}");
    noSecret(submitText, "submit");

    const status = await fetch(`${base}/api/status?id=job-9`, { headers });
    const statusText = await status.text();
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(statusText).ready, true);
    noSecret(statusText, "status");

    const file = await fetch(`${base}/api/file?id=job-9`, { headers });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "video/mp4");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "videobytes");
    noSecret(file.headers.get("content-type"), "file type");

    const leaked = [...logs, ...calls.map((call) => call.opts.body && typeof call.opts.body === "string" ? call.opts.body : "")].join("\n");
    noSecret(leaked, "logs and workflow");
    assert.equal(calls.every((call) => call.href.startsWith("https://example.test/")), true);
  });
});

test("upstream errors do not echo the key", async () => {
  const fetchImpl = async () => Response.json(
    { error: { message: `denied ${SENTINEL}` } },
    { status: 500 },
  );
  await withServer({
    env: { COMFY_CLOUD_API_KEY: SENTINEL, COMFY_DEPLOYMENT_ENDPOINT: "https://example.test" },
    fetchImpl,
  }, async (base, logs) => {
    const cookie = await login(base);
    const headers = { cookie, "content-type": "application/json" };
    const routes = [
      ["/api/upload", { method: "POST", headers: { cookie, "content-type": "image/png" }, body: PNG }],
      ["/api/submit", { method: "POST", headers, body: JSON.stringify({ image: "a.png", look: "neon", brief: "x", seed: 1, duration: 2 }) }],
      ["/api/status?id=job-9", { headers: { cookie } }],
      ["/api/file?id=job-9", { headers: { cookie } }],
    ];
    for (const [pathname, init] of routes) {
      const res = await fetch(`${base}${pathname}`, init);
      const text = await res.text();
      assert.equal(res.status, 503, pathname);
      assert.equal(text, "{\"error\":\"Renderer is offline\"}");
      noSecret(text, pathname);
      for (const [key, value] of res.headers) noSecret(`${key}:${value}`, pathname);
    }
    noSecret(logs.join("\n"), "logs");
  });
});
