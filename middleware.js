import { next, rewrite } from "@vercel/functions";
import { route } from "./lib/edge.mjs";
import { userFromHeaders } from "./lib/session.mjs";

// Vercel Routing Middleware: gates every request behind the signed session cookie.
// The local server (server.mjs) does the same checks itself and never loads this file.
export const config = { runtime: "nodejs" };

export default function middleware(request) {
  const url = new URL(request.url);
  const user = userFromHeaders({ cookie: request.headers.get("cookie") || "" });
  const decision = route({ method: request.method, pathname: url.pathname, user });
  const plain = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  switch (decision.type) {
    case "next":
      return next();
    case "rewrite":
      return rewrite(new URL(decision.to, request.url));
    case "redirect":
      return new Response(null, { status: 302, headers: { Location: decision.to, "Cache-Control": "no-store" } });
    default:
      return new Response(decision.body, { status: decision.status, headers: plain });
  }
}
