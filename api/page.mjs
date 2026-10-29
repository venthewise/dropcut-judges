import path from "node:path";
import { redirect, renderIndex, send, sessionUser } from "../lib/web.mjs";

// The gated cut sheet. The middleware rewrites / and /index.html here.
const ROOT = path.join(process.cwd());

export default function page(req, res) {
  try {
    const user = sessionUser(req);
    if (!user) {
      req.resume();
      redirect(res, "/login");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
      return;
    }
    let html;
    try {
      html = renderIndex(user, ROOT);
    } catch {
      html = renderIndex(user);
    }
    send(res, 200, html, "text/html; charset=utf-8");
  } catch {
    console.error("Request failed");
    if (!res.headersSent) send(res, 500, "Server error");
  }
}
