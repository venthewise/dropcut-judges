import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless signed sessions: base64url(JSON {u, exp, n}) + "." + base64url(HMAC-SHA256).
export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 8 * 60 * 60;
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{43}$/;

let localSecret = null;

export function isServerless(env = process.env) {
  return Boolean(env.VERCEL);
}

// SESSION_SECRET is required on Vercel. Locally a random per-process secret is used
// when none is set, so sessions end when the server restarts (same as before).
export function sessionSecret(env = process.env) {
  const value = String(env.SESSION_SECRET || "").trim();
  if (value) {
    if (value.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return value;
  }
  if (isServerless(env)) throw new Error("SESSION_SECRET is not set");
  if (!localSecret) localSecret = randomBytes(32).toString("hex");
  return localSecret;
}

function mac(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(username, secret, now = Date.now(), maxAge = SESSION_MAX_AGE) {
  if (!USERNAME_RE.test(String(username))) throw new Error("Invalid username");
  const body = Buffer.from(JSON.stringify({
    u: username,
    exp: Math.floor(now / 1000) + maxAge,
    n: randomBytes(8).toString("base64url"),
  })).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

const revoked = new Map();

// Best effort: logout revokes the token in this process only. On Vercel another
// instance may still accept it until it expires; the browser cookie is cleared either way.
export function revokeSession(token, now = Date.now()) {
  if (!TOKEN_RE.test(String(token))) return;
  for (const [key, until] of revoked) if (until <= now) revoked.delete(key);
  revoked.set(token, now + SESSION_MAX_AGE * 1000);
}

export function verifySession(token, secret, now = Date.now()) {
  const value = String(token || "");
  if (!TOKEN_RE.test(value)) return null;
  const dot = value.indexOf(".");
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = Buffer.from(mac(body, secret), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || !USERNAME_RE.test(String(data.u)) || !Number.isInteger(data.exp)) return null;
  if (data.exp * 1000 <= now) return null;
  if (revoked.has(value)) return null;
  return data.u;
}

export function readCookie(header, name = SESSION_COOKIE) {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

export function sessionCookie(token, { secure = false, maxAge = SESSION_MAX_AGE } = {}) {
  return `${SESSION_COOKIE}=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}

// Secure on https (Vercel terminates TLS and sets x-forwarded-proto).
export function isHttps(headers = {}, env = process.env) {
  const proto = String(headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https" || (isServerless(env) && proto !== "http");
}

export function userFromHeaders(headers = {}, env = process.env) {
  let secret;
  try {
    secret = sessionSecret(env);
  } catch {
    return null;
  }
  return verifySession(readCookie(headers.cookie), secret);
}
