import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_MAX_AGE,
  clearCookie,
  isHttps,
  readCookie,
  revokeSession,
  sessionCookie,
  sessionSecret,
  signSession,
  verifySession,
} from "../lib/session.mjs";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

test("signed session: valid token returns the username", () => {
  const now = Date.UTC(2026, 9, 29, 5, 0, 0);
  const token = signSession("judge1", SECRET, now);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifySession(token, SECRET, now + 1000), "judge1");
  assert.equal(SESSION_MAX_AGE, 8 * 60 * 60);
});

test("signed session: tampered payload, signature, or secret is rejected", () => {
  const now = Date.now();
  const token = signSession("judge1", SECRET, now);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "admin", exp: Math.floor(now / 1000) + 9999, n: "x" })).toString("base64url");
  assert.equal(verifySession(`${forged}.${sig}`, SECRET, now), null);
  const flipped = sig.slice(0, -2) + (sig.at(-2) === "A" ? "B" : "A") + sig.at(-1);
  assert.equal(verifySession(`${body}.${flipped}`, SECRET, now), null);
  assert.equal(verifySession(token, `${SECRET}-other`, now), null);
  assert.equal(verifySession("", SECRET, now), null);
  assert.equal(verifySession("a".repeat(64), SECRET, now), null);
  assert.equal(verifySession(`${body}.${sig}.extra`, SECRET, now), null);
});

test("signed session: expires after 8 hours", () => {
  const now = Date.UTC(2026, 9, 29, 5, 0, 0);
  const token = signSession("judge1", SECRET, now);
  assert.equal(verifySession(token, SECRET, now + (SESSION_MAX_AGE - 1) * 1000), "judge1");
  assert.equal(verifySession(token, SECRET, now + SESSION_MAX_AGE * 1000), null);
  assert.equal(verifySession(token, SECRET, now + (SESSION_MAX_AGE + 60) * 1000), null);
});

test("signed session: logout revokes the token in this process", () => {
  const token = signSession("judge1", SECRET);
  assert.equal(verifySession(token, SECRET), "judge1");
  revokeSession(token);
  assert.equal(verifySession(token, SECRET), null);
});

test("cookie flags: HttpOnly, SameSite=Lax, Secure only on https", () => {
  const plain = sessionCookie("abc.def");
  assert.match(plain, /^session=abc\.def; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);
  const secure = sessionCookie("abc.def", { secure: true });
  assert.match(secure, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(clearCookie({ secure: true }), /Max-Age=0/);
  assert.equal(isHttps({ "x-forwarded-proto": "https" }, {}), true);
  assert.equal(isHttps({}, {}), false);
  assert.equal(isHttps({}, { VERCEL: "1" }), true);
  assert.equal(readCookie("a=1; session=xyz; b=2"), "xyz");
});

test("session secret: required on Vercel, random locally, rejects short values", () => {
  assert.throws(() => sessionSecret({ VERCEL: "1" }), /SESSION_SECRET is not set/);
  assert.throws(() => sessionSecret({ SESSION_SECRET: "short" }), /at least 32/);
  assert.equal(sessionSecret({ SESSION_SECRET: SECRET }), SECRET);
  const local = sessionSecret({});
  assert.match(local, /^[0-9a-f]{64}$/);
  assert.equal(sessionSecret({}), local);
});
