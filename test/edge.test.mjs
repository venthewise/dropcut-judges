import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/edge.mjs";

test("middleware: signed out", () => {
  assert.deepEqual(route({ pathname: "/" }), { type: "redirect", to: "/login" });
  assert.deepEqual(route({ pathname: "/index.html" }), { type: "redirect", to: "/login" });
  assert.equal(route({ pathname: "/login" }).type, "next");
  assert.equal(route({ method: "POST", pathname: "/login" }).type, "next");
  assert.equal(route({ method: "POST", pathname: "/logout" }).type, "next");
  assert.equal(route({ pathname: "/favicon.ico" }).type, "next");
  assert.equal(route({ pathname: "/vendor/ffmpeg/ffmpeg-core.wasm" }).type, "next");
  for (const p of ["/media/listing.mp4", "/media/song-60s.m4a", "/app.js", "/styles.css", "/data.js", "/lib/cuts.mjs", "/api/upload", "/api/health", "/api/page"]) {
    assert.equal(route({ pathname: p }).status, 401, p);
  }
});

test("middleware: signed in", () => {
  const user = "judge1";
  assert.deepEqual(route({ pathname: "/", user }), { type: "rewrite", to: "/api/page" });
  assert.deepEqual(route({ pathname: "/index.html", user }), { type: "rewrite", to: "/api/page" });
  for (const p of ["/app.js", "/data.js", "/styles.css", "/lib/cuts.mjs", "/media/listing.mp4", "/media/song-30s.m4a", "/media/logo.webp"]) {
    assert.equal(route({ pathname: p, user }).type, "next", p);
  }
  assert.equal(route({ method: "POST", pathname: "/api/upload", user }).type, "next");
  assert.equal(route({ pathname: "/api/status", user }).type, "next");
  assert.equal(route({ pathname: "/api/page", user }).status, 404);
});

test("middleware: source, secrets and traversal never served", () => {
  const user = "judge1";
  for (const p of ["/server.mjs", "/middleware.js", "/lib/web.mjs", "/lib/session.mjs", "/lib/accounts.mjs", "/api/upload.mjs",
    "/workflows/ltx-i2v.api.json", "/package.json", "/README.md", "/judges.json", "/.env", "/test/gate.test.mjs",
    "/scripts/add-judge.mjs", "/media/../server.mjs", "/%6Cib/web.mjs", "/media/x.html", "/vendor/ffmpeg/other.js"]) {
    const r = route({ pathname: p, user });
    assert.ok(r.type === "status" && r.status >= 400, p);
  }
  assert.equal(route({ pathname: "/%E0%A4%A", user }).status, 400);
  assert.equal(route({ pathname: "/a\\b", user }).status, 400);
});
