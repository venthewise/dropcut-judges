import { handleLogout } from "../lib/web.mjs";
import { apiRoute } from "../lib/vercel.mjs";

// Served at /logout via vercel.json.
export default apiRoute(["POST"], (req, res) => handleLogout(req, res), { auth: false });
