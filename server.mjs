import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_FAILURES,
  RATE_WINDOW_MS,
  createLimiter,
  freshFailures,
  handleLogin,
  handleLogout,
  redirect,
  renderIndex,
  send,
  sendLanding,
  sendLogin,
  sessionUser,
} from "./lib/web.mjs";
import { createRuntime } from "./lib/runtime.mjs";
import { handleUpload } from "./api/upload.mjs";
import { handleSubmit } from "./api/submit.mjs";
import { handleHealth, handleStatus } from "./api/status.mjs";
import { handleFile } from "./api/file.mjs";

export const HOST = "127.0.0.1";
export const PORT = 5180;
export { RATE_WINDOW_MS, MAX_FAILURES, freshFailures };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FAVICON = path.join(ROOT, "media", "icon.png");

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const STATIC_FILES = new Map([
  ["/app.js", "app.js"],
  ["/data.js", "data.js"],
  ["/styles.css", "styles.css"],
  ["/lib/cuts.mjs", "lib/cuts.mjs"],
  ["/vendor/ffmpeg/ffmpeg.js", "vendor/ffmpeg/ffmpeg.js"],
  ["/vendor/ffmpeg/814.ffmpeg.js", "vendor/ffmpeg/814.ffmpeg.js"],
  ["/vendor/ffmpeg/ffmpeg-core.js", "vendor/ffmpeg/ffmpeg-core.js"],
  ["/vendor/ffmpeg/ffmpeg-core.wasm", "vendor/ffmpeg/ffmpeg-core.wasm"],
  ["/vendor/fonts/Anton-Regular.ttf", "vendor/fonts/Anton-Regular.ttf"],
  ["/vendor/fonts/OFL.txt", "vendor/fonts/OFL.txt"],
]);

export function createApp(options = {}) {
  const runtime = createRuntime(options);
  const state = {
    failures: createLimiter(),
  };
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res, state, runtime)).catch(() => {
      console.error("Request failed");
      if (!res.headersSent) send(res, 500, "Server error");
      else res.destroy();
    });
  });
  return server;
}

function routeApi(req, res, pathname, method, runtime) {
  if (pathname === "/api/health" && (method === "GET" || method === "HEAD")) return handleHealth(req, res, runtime);
  if (pathname === "/api/upload" && method === "POST") return handleUpload(req, res, runtime);
  if (pathname === "/api/submit" && method === "POST") return handleSubmit(req, res, runtime);
  if (pathname === "/api/status" && (method === "GET" || method === "HEAD")) return handleStatus(req, res, runtime);
  if (pathname === "/api/file" && (method === "GET" || method === "HEAD")) return handleFile(req, res, runtime);
  if (pathname.startsWith("/api/")) {
    send(res, 404, "Not found");
    return undefined;
  }
  return undefined;
}

function handle(req, res, state, runtime) {
  const method = req.method || "GET";
  let url;
  try {
    url = new URL(req.url || "/", `http://${HOST}`);
  } catch {
    send(res, 400, "Bad request");
    return undefined;
  }
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  if ((method === "GET" || method === "HEAD") && (pathname === "/favicon" || pathname === "/favicon.ico")) {
    return serveFile(req, res, FAVICON, "image/png");
  }
  // Public on every page. styles.css and app.js stay behind the session.
  if ((method === "GET" || method === "HEAD") && pathname === "/theme.js") {
    return serveFile(req, res, path.join(ROOT, "theme.js"), MIME[".js"]);
  }
  if (pathname === "/login" && (method === "GET" || method === "HEAD")) {
    if (sessionUser(req)) {
      redirect(res, "/");
      return undefined;
    }
    sendLogin(res, 200, { username: "", error: "" });
    return undefined;
  }
  if (pathname === "/login" && method === "POST") return handleLogin(req, res, state.failures);
  if (pathname === "/logout" && method === "POST") {
    handleLogout(req, res);
    return undefined;
  }

  const user = sessionUser(req);
  if (!user) {
    if ((method === "GET" || method === "HEAD") && pathname === "/") {
      sendLanding(res);
      return undefined;
    }
    if ((method === "GET" || method === "HEAD") && pathname.endsWith(".html")) {
      redirect(res, "/login");
      return undefined;
    }
    send(res, 401, "Unauthorized");
    return undefined;
  }
  if (pathname.startsWith("/api/")) return routeApi(req, res, pathname, method, runtime);
  if (method !== "GET" && method !== "HEAD") {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
    return undefined;
  }
  if (pathname === "/" || pathname === "/index.html") {
    send(res, 200, renderIndex(user), "text/html; charset=utf-8");
    return undefined;
  }
  const file = resolveStatic(pathname);
  if (!file) {
    send(res, 404, "Not found");
    return undefined;
  }
  return serveFile(req, res, file, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
}

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return null;
  if (STATIC_FILES.has(decoded)) return path.join(ROOT, STATIC_FILES.get(decoded));
  if (!decoded.startsWith("/media/")) return null;
  const base = path.basename(decoded);
  if (!base || base !== decoded.slice("/media/".length)) return null;
  const ext = path.extname(base).toLowerCase();
  if (![".webp", ".png", ".mp4", ".m4a"].includes(ext)) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  return path.join(ROOT, "media", base);
}

function serveFile(req, res, filePath, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    send(res, 404, "Not found");
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, "Not found");
    return;
  }
  const headers = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const range = parseRange(req.headers.range, stat.size);
  if (range?.unsatisfiable) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Content-Length": 0 });
    res.end();
    return;
  }
  let status = 200;
  let start;
  let end;
  if (range) {
    status = 206;
    start = range.start;
    end = range.end;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["Content-Length"] = String(end - start + 1);
  } else {
    headers["Content-Length"] = String(stat.size);
  }
  if (req.method === "HEAD") {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath, start === undefined ? {} : { start, end });
  stream.on("error", () => {
    if (!res.headersSent) send(res, 500, "Server error");
    else res.destroy();
  });
  res.writeHead(status, headers);
  stream.pipe(res);
}

function parseRange(header, size) {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const invoked = path.resolve(entry);
  const self = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isDirectRun()) {
  const server = createApp();
  server.on("error", (err) => {
    console.error(err && err.code === "EADDRINUSE" ? `Port ${PORT} is already in use on ${HOST}` : "Server failed to start");
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`http://${HOST}:${PORT}`);
  });
}
