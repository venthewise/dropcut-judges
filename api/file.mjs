import { Readable } from "node:stream";
import { sendJson, sendOffline } from "../lib/http.mjs";
import { fetchAssetResponse, fetchJob, outputFetchUrl } from "../lib/comfy.mjs";
import { finishJob } from "../lib/runtime.mjs";
import { findOutput, loadWorkflowFiles } from "../lib/workflow.mjs";

function jobId(req) {
  const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return "";
  return id;
}

function pipeBody(res, webRes) {
  const headers = {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const type = String(webRes.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/") || type === "application/octet-stream") headers["Content-Type"] = type;
  const len = webRes.headers.get("content-length");
  // On Vercel, stream without Content-Length so large clips are not held to the 4.5 MB body limit.
  if (len && /^\d+$/.test(len) && !process.env.VERCEL) headers["Content-Length"] = len;
  res.writeHead(200, headers);
  if (res.req?.method === "HEAD" || !webRes.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(webRes.body);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export async function handleFile(req, res, ctx) {
  const id = jobId(req);
  if (!id) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  if (ctx.offline()) {
    sendOffline(res);
    return;
  }
  try {
    const job = await fetchJob({
      endpoint: ctx.endpoint,
      key: ctx.key,
      id,
      fetchImpl: ctx.fetchImpl,
    });
    const { map } = loadWorkflowFiles(ctx.root);
    const output = findOutput(job, map);
    const url = outputFetchUrl(ctx.endpoint, output);
    if (!url) {
      finishJob(ctx, id);
      sendOffline(res);
      return;
    }
    const file = await fetchAssetResponse({
      endpoint: ctx.endpoint,
      key: ctx.key,
      url,
      fetchImpl: ctx.fetchImpl,
    });
    finishJob(ctx, id);
    pipeBody(res, file);
  } catch {
    finishJob(ctx, id);
    if (!res.headersSent) sendOffline(res);
    else res.destroy();
  }
}

import { apiRoute } from "../lib/vercel.mjs";

export default apiRoute(["GET", "HEAD"], handleFile);
