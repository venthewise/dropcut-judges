import { handleHealth } from "./status.mjs";
import { apiRoute } from "../lib/vercel.mjs";

export default apiRoute(["GET", "HEAD"], handleHealth);
