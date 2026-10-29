import { readRaw, sendJson, sendOffline, uploadLimit } from "../lib/http.mjs";
import { uploadAsset } from "../lib/comfy.mjs";

const TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function mediaType(header) {
  const type = String(header || "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return TYPES[type] ? type : "";
}

function safeFilename(header, type) {
  const ext = TYPES[type];
  const base = String(header || "shot").split(/[/\\]/).pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  const stem = cleaned.replace(/\.(jpe?g|png|webp)$/i, "") || "shot";
  return `${stem}${ext}`;
}

export async function handleUpload(req, res, ctx) {
  if (ctx.offline()) {
    req.resume();
    sendOffline(res);
    return;
  }
  const type = mediaType(req.headers["content-type"]);
  if (!type) {
    req.resume();
    sendJson(res, 400, { error: "Use a jpg, png, or webp photo." });
    return;
  }
  const limit = uploadLimit();
  const tooBig = limit < 25 * 1024 * 1024 ? "Photo is too large after resizing. Try a smaller photo." : "Each photo must be 25 MB or smaller.";
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    sendJson(res, 413, { error: tooBig });
    return;
  }
  let bytes;
  try {
    bytes = await readRaw(req, limit);
  } catch (err) {
    if (err && err.status === 413) {
      sendJson(res, 413, { error: tooBig });
      return;
    }
    sendJson(res, 400, { error: "Upload failed." });
    return;
  }
  if (!bytes.length) {
    sendJson(res, 400, { error: "Empty photo." });
    return;
  }
  const filename = safeFilename(req.headers["x-filename"], type);
  try {
    const uploaded = await uploadAsset({
      endpoint: ctx.endpoint,
      key: ctx.key,
      bytes,
      filename,
      contentType: type,
      fetchImpl: ctx.fetchImpl,
    });
    sendJson(res, 200, { name: uploaded.name });
  } catch {
    sendOffline(res);
  }
}

import { apiRoute } from "../lib/vercel.mjs";

export default apiRoute(["POST"], handleUpload);
