import { createLimiter, handleLogin, redirect, sendLogin, sessionUser } from "../lib/web.mjs";
import { apiRoute } from "../lib/vercel.mjs";

// Served at /login via vercel.json. The limiter lives per warm instance (best effort).
const failures = createLimiter();

export default apiRoute(["GET", "HEAD", "POST"], async (req, res) => {
  if (req.method === "POST") {
    await handleLogin(req, res, failures);
    return;
  }
  if (sessionUser(req)) {
    redirect(res, "/");
    return;
  }
  sendLogin(res, 200, { username: "", error: "" });
}, { auth: false });
