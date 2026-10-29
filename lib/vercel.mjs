import { createRuntime } from "./runtime.mjs";
import { send, sessionUser } from "./web.mjs";

// Glue for Vercel functions in api/. Each function checks the signed session itself,
// on top of the routing middleware, and reuses one runtime per warm instance.
let runtime = null;

export function getRuntime() {
  if (!runtime) runtime = createRuntime();
  return runtime;
}

export function apiRoute(methods, handler, { auth = true } = {}) {
  return async function vercelHandler(req, res) {
    const method = req.method || "GET";
    try {
      if (auth && !sessionUser(req)) {
        req.resume();
        send(res, 401, "Unauthorized");
        return;
      }
      if (!methods.includes(method)) {
        req.resume();
        send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: methods.join(", ") });
        return;
      }
      await handler(req, res, getRuntime());
    } catch {
      console.error("Request failed");
      if (!res.headersSent) send(res, 500, "Server error");
      else res.destroy();
    }
  };
}
