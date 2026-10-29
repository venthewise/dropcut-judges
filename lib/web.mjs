import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USERNAME_RE, loadJudges, passwordMatches } from "./accounts.mjs";
import {
  clearCookie,
  isHttps,
  isServerless,
  readCookie,
  revokeSession,
  sessionCookie,
  sessionSecret,
  signSession,
  userFromHeaders,
} from "./session.mjs";

// Shared by the local server (server.mjs) and the Vercel functions (api/*.mjs).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 5;
const BAD_LOGIN = "Unknown username or password.";
const LIMITED = "Too many attempts. Wait 15 minutes and try again.";

export function freshFailures(timestamps, now) {
  return timestamps.filter((stamp) => now - stamp < RATE_WINDOW_MS);
}

// Best-effort login limiter. On Vercel it is per function instance.
export function createLimiter() {
  return new Map();
}

export function clientIp(req) {
  if (isServerless()) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  const raw = req.socket?.remoteAddress || "unknown";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

export function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  const buf = Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  if (res.req?.method === "HEAD") res.end();
  else res.end(buf);
}

export function redirect(res, location, status = 302, extra = {}) {
  res.writeHead(status, {
    Location: location,
    "Content-Length": 0,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end();
}

export function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function renderIndex(username, root = ROOT) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (!html.includes("{{judge}}")) throw new Error("Missing judge slot");
  return html.replaceAll("{{judge}}", escapeHtml(username));
}

export function sessionUser(req) {
  return userFromHeaders(req.headers);
}

export function sendLogin(res, status, { username, error }) {
  send(res, status, loginHtml({ username, error }), "text/html; charset=utf-8");
}

export function sendLanding(res) {
  send(res, 200, landingHtml(), "text/html; charset=utf-8");
}

export async function handleLogin(req, res, failures) {
  const type = String(req.headers["content-type"] || "");
  if (!type.includes("application/x-www-form-urlencoded")) {
    req.resume();
    send(res, 400, "Expected a form.");
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, "Too large");
    return;
  }
  const params = new URLSearchParams(raw);
  const username = (params.get("username") || "").trim();
  const password = params.get("password") ?? "";
  const shown = username.slice(0, 32);
  const ip = clientIp(req);
  const now = Date.now();
  const fresh = freshFailures(failures.get(ip) || [], now);
  if (fresh.length >= MAX_FAILURES) {
    failures.set(ip, fresh);
    sendLogin(res, 429, { username: shown, error: LIMITED });
    return;
  }
  const judges = loadJudges();
  const record = USERNAME_RE.test(username) ? judges[username] : null;
  if (!passwordMatches(password, record)) {
    fresh.push(now);
    failures.set(ip, fresh);
    sendLogin(res, 401, { username: shown, error: BAD_LOGIN });
    return;
  }
  failures.delete(ip);
  const token = signSession(username, sessionSecret(), now);
  redirect(res, "/", 303, { "Set-Cookie": sessionCookie(token, { secure: isHttps(req.headers) }) });
}

export function handleLogout(req, res) {
  req.resume();
  revokeSession(readCookie(req.headers.cookie));
  redirect(res, "/login", 303, { "Set-Cookie": clearCookie({ secure: isHttps(req.headers) }) });
}

// Shared by the login and landing pages. The cut sheet keeps the same tokens
// in styles.css. /theme.js is the only script these public pages load.
const PUBLIC_THEME_CSS = `
    :root {
      --ink: #0a0a0a; --paper: #f4f1ea; --acid: #d1fe17; --muted: #5c5c5c;
      --panel: #ffffff; --on-acid: #0a0a0a; --slab: #0a0a0a; --slab-text: #d1fe17;
      --grid: rgba(10, 10, 10, 0.06); color-scheme: light;
    }
    html[data-theme="dark"] {
      --ink: #f4f1ea; --paper: #0e0e0c; --acid: #d1fe17; --muted: #c8c3b8;
      --panel: #1c1b17; --grid: rgba(244, 241, 234, 0.08); color-scheme: dark;
    }
    .mast-end { display: flex; align-items: center; gap: 8px; }
    .theme-toggle {
      appearance: none; border-radius: 0;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
      background: transparent; color: var(--ink); border: 1px solid var(--ink);
      padding: 4px 8px; cursor: pointer; line-height: 1.2; white-space: nowrap;
    }
    .theme-toggle:hover { background: var(--acid); color: var(--on-acid); }
    .theme-toggle .theme-to-light { display: none; }
    html[data-theme="dark"] .theme-toggle .theme-to-dark { display: none; }
    html[data-theme="dark"] .theme-toggle .theme-to-light { display: inline; }
`;

function themeToggle() {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" aria-label="Switch to dark mode"><span class="theme-to-dark">Dark</span><span class="theme-to-light">Light</span></button>`;
}

export function loginHtml({ username, error, hosted = isServerless() }) {
  const badge = hosted ? "Judges only" : "Local only";
  const message = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <script src="/theme.js"></script>
  <title>Judges access</title>
  <link rel="icon" type="image/png" href="/favicon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wdth,wght@75..125,400;75..125,600;75..125,800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    ${PUBLIC_THEME_CSS}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--paper); color: var(--ink); min-height: 100%; }
    body { font-family: Archivo, system-ui, sans-serif; line-height: 1.4; }
    :focus-visible { outline: 3px solid var(--acid); outline-offset: 2px; }
    .grid-overlay {
      pointer-events: none; position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 12.5% 48px;
    }
    .mast {
      position: relative; z-index: 1;
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      padding: 18px clamp(16px, 3vw, 40px);
      border-bottom: 2px solid var(--ink); background: var(--paper);
    }
    .stack { display: flex; flex-direction: column; gap: 2px; }
    .stack strong { font-family: "Archivo Black", sans-serif; letter-spacing: -0.03em; font-size: 0.95rem; }
    .stack span, .badge, .running, label, .error {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .stack span { font-size: 11px; letter-spacing: 0.12em; }
    .badge {
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
      background: var(--acid); color: var(--on-acid); border: 1px solid var(--ink); padding: 4px 8px;
    }
    .running {
      position: relative; z-index: 1;
      font-size: 11px; letter-spacing: 0.22em;
      border-bottom: 1px solid var(--ink);
      padding: 8px clamp(16px, 3vw, 40px);
    }
    main { position: relative; z-index: 1; padding: 36px clamp(16px, 3vw, 40px) 64px; }
    h1 {
      font-family: "Archivo Black", sans-serif;
      font-size: clamp(2.6rem, 8vw, 4.6rem);
      letter-spacing: -0.045em; line-height: 0.9;
      margin-bottom: 22px;
    }
    form {
      max-width: 440px; display: grid; gap: 14px;
      background: var(--panel); border: 2px solid var(--ink); padding: 18px;
    }
    label { display: grid; gap: 6px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
    input {
      font: 16px Archivo, system-ui, sans-serif; color: var(--ink);
      background: var(--panel); border: 2px solid var(--ink); padding: 12px;
    }
    input:-webkit-autofill {
      -webkit-text-fill-color: var(--ink); caret-color: var(--ink);
      box-shadow: 0 0 0 1000px var(--panel) inset;
    }
    .error { border: 2px solid var(--ink); background: var(--acid); color: var(--on-acid); padding: 10px 12px; font-size: 12px; letter-spacing: 0.04em; }
    .btn {
      font-family: "Archivo Black", sans-serif; text-transform: uppercase; letter-spacing: 0.04em;
      font-size: 0.95rem; padding: 14px 18px; border: 2px solid var(--ink); cursor: pointer;
    }
    .btn.solid { background: var(--ink); color: var(--paper); }
    .btn.solid:hover { background: var(--acid); color: var(--on-acid); }
  </style>
</head>
<body>
  <div class="grid-overlay" aria-hidden="true"></div>
  <header class="mast">
    <div class="stack"><strong>DROPCUT</strong><span>ISSUE 01 / JUDGES</span></div>
    <div class="mast-end">${themeToggle()}<span class="badge">${badge}</span></div>
  </header>
  <p class="running">JUDGES · ${badge.toUpperCase()} · SIGN IN TO OPEN THE CUT SHEET</p>
  <main>
    <h1>Judges access</h1>
    <form method="post" action="/login">
      <label>Username
        <input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required maxlength="32" value="${escapeHtml(username)}">
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required maxlength="256">
      </label>
      ${message}
      <button class="btn solid" type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

// styles.css is session-gated, so this public page inlines the same variables,
// type, and chrome as the login screen. The theme file is the only script.
export function landingHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <script src="/theme.js"></script>
  <title>DropCut</title>
  <link rel="icon" type="image/png" href="/favicon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wdth,wght@75..125,400;75..125,600;75..125,800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    ${PUBLIC_THEME_CSS}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--paper); color: var(--ink); min-height: 100%; }
    body { font-family: Archivo, system-ui, sans-serif; line-height: 1.4; }
    a { color: inherit; }
    :focus-visible { outline: 3px solid var(--acid); outline-offset: 2px; }
    .grid-overlay {
      pointer-events: none; position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 12.5% 48px;
    }
    .mast {
      position: relative; z-index: 1;
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      padding: 18px clamp(16px, 3vw, 40px);
      border-bottom: 2px solid var(--ink); background: var(--paper);
    }
    .stack { display: flex; flex-direction: column; gap: 2px; }
    .stack strong { font-family: "Archivo Black", sans-serif; letter-spacing: -0.03em; font-size: 0.95rem; }
    .stack span, .running, .door span {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .stack span { font-size: 11px; letter-spacing: 0.12em; }
    .running {
      position: relative; z-index: 1;
      font-size: 11px; letter-spacing: 0.22em;
      border-bottom: 1px solid var(--ink);
      padding: 8px clamp(16px, 3vw, 40px);
    }
    main { position: relative; z-index: 1; padding: 28px clamp(16px, 3vw, 40px) 64px; }
    .doors {
      display: grid; grid-template-columns: 1fr 1fr;
      min-height: min(68vh, 640px);
      border: 2px solid var(--ink); background: var(--panel);
    }
    a.door {
      display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start;
      gap: 12px; min-height: 240px;
      padding: clamp(22px, 4vw, 40px);
      text-decoration: none; color: var(--ink); background: var(--panel);
    }
    a.door + a.door { border-left: 2px solid var(--ink); }
    a.door strong {
      font-family: "Archivo Black", sans-serif;
      font-size: clamp(3.4rem, 10vw, 7rem);
      letter-spacing: -0.05em; line-height: 0.82;
    }
    a.door span { font-size: 13px; letter-spacing: 0.04em; color: var(--muted); }
    a.door:hover, a.door:focus-visible { background: var(--acid); color: var(--on-acid); }
    a.door:hover span, a.door:focus-visible span { color: var(--on-acid); }
    a.door.solid { background: var(--slab); color: var(--slab-text); }
    a.door.solid:hover, a.door.solid:focus-visible { background: var(--acid); color: var(--on-acid); }
    a.back-home {
      display: block; width: fit-content; max-width: 100%;
      margin: clamp(28px, 5vh, 48px) auto 0;
      padding: 4px 8px;
      font-family: "Archivo Black", sans-serif;
      font-size: clamp(1.25rem, 1.05rem + 1.2vw, 2rem);
      letter-spacing: -0.03em; line-height: 1.15; text-align: center;
      text-transform: uppercase; text-decoration: none; color: var(--ink);
    }
    a.back-home:hover,
    a.back-home:focus-visible { background: var(--acid); color: var(--on-acid); }
    @media (max-width: 639px) {
      .doors { grid-template-columns: 1fr; }
      a.door + a.door { border-left: none; border-top: 2px solid var(--ink); }
    }
  </style>
</head>
<body>
  <div class="grid-overlay" aria-hidden="true"></div>
  <header class="mast">
    <div class="stack"><strong>DROPCUT</strong><span>ISSUE 01 / OPEN SOURCE</span></div>
    ${themeToggle()}
  </header>
  <p class="running">DROPCUT · ISSUE 01</p>
  <main>
    <div class="doors">
      <a class="door" href="https://github.com/venthewise/dropcut-judges" target="_blank" rel="noopener">
        <strong>USER</strong>
        <span>Check out the github repo!</span>
      </a>
      <a class="door solid" href="/login">
        <strong>JUDGE</strong>
      </a>
    </div>
    <a class="back-home" href="https://dropcut.moordecai.com/">BACK TO DROPCUT HOMEPAGE</a>
  </main>
</body>
</html>`;
}

