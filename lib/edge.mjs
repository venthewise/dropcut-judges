// Pure routing decisions for the Vercel middleware (middleware.js). Kept free of
// Vercel imports so it can be unit-tested with node --test.
export const PUBLIC_PATHS = new Set([
  "/login",
  "/logout",
  "/api/login",
  "/api/logout",
  "/favicon",
  "/favicon.ico",
  "/vendor/ffmpeg/ffmpeg.js",
  "/vendor/ffmpeg/814.ffmpeg.js",
  "/vendor/ffmpeg/ffmpeg-core.js",
  "/vendor/ffmpeg/ffmpeg-core.wasm",
  "/vendor/fonts/Anton-Regular.ttf",
  "/vendor/fonts/OFL.txt",
]);

export const GATED_FILES = new Set(["/app.js", "/data.js", "/styles.css", "/lib/cuts.mjs"]);
export const API_PATHS = new Set(["/api/health", "/api/upload", "/api/submit", "/api/status", "/api/file"]);
const MEDIA_RE = /^\/media\/[A-Za-z0-9._-]+\.(webp|png|mp4|m4a)$/;

export function normalize(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname || "/");
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..") || decoded.includes("//")) return null;
  if (decoded.length > 1 && decoded.endsWith("/")) decoded = decoded.slice(0, -1);
  return decoded;
}

// Returns one of: {type:"next"}, {type:"rewrite", to}, {type:"redirect", to},
// {type:"status", status, body}.
export function route({ method = "GET", pathname = "/", user = null }) {
  const path = normalize(pathname);
  if (path === null) return { type: "status", status: 400, body: "Bad request" };
  const read = method === "GET" || method === "HEAD";
  if (PUBLIC_PATHS.has(path)) return { type: "next" };
  if (!user) {
    if (read && (path === "/" || path.endsWith(".html"))) return { type: "redirect", to: "/login" };
    return { type: "status", status: 401, body: "Unauthorized" };
  }
  if (path === "/" || path === "/index.html") {
    if (!read) return { type: "status", status: 405, body: "Method not allowed" };
    return { type: "rewrite", to: "/api/page" };
  }
  if (API_PATHS.has(path)) return { type: "next" };
  if (path.startsWith("/api/")) return { type: "status", status: 404, body: "Not found" };
  if (!read) return { type: "status", status: 405, body: "Method not allowed" };
  if (GATED_FILES.has(path) || MEDIA_RE.test(path)) return { type: "next" };
  return { type: "status", status: 404, body: "Not found" };
}
