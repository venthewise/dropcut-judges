import { sendLanding } from "../lib/web.mjs";
import { apiRoute } from "../lib/vercel.mjs";

// Anonymous GET / is rewritten here. The local server renders the same HTML itself.
export default apiRoute(["GET", "HEAD"], (req, res) => {
  sendLanding(res);
}, { auth: false });
