import { sendJson, sendOffline } from "../lib/http.mjs";
import { fetchJob } from "../lib/comfy.mjs";
import { finishJob } from "../lib/runtime.mjs";
import { findOutput, loadWorkflowFiles } from "../lib/workflow.mjs";

const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

function jobId(req) {
  const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return "";
  return id;
}

export function handleHealth(req, res, ctx) {
  if (ctx.offline()) {
    sendOffline(res);
    return;
  }
  sendJson(res, 200, { ok: true });
}

export async function handleStatus(req, res, ctx) {
  const id = jobId(req);
  if (!id) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  if (ctx.offline()) {
    sendOffline(res);
    return;
  }
  let job;
  try {
    job = await fetchJob({
      endpoint: ctx.endpoint,
      key: ctx.key,
      id,
      fetchImpl: ctx.fetchImpl,
    });
  } catch {
    sendOffline(res);
    return;
  }
  const status = String(job?.status || "running").toLowerCase();
  if (FAILED.has(status) || job?.error) {
    finishJob(ctx, id);
    sendOffline(res);
    return;
  }
  let ready = status === "completed" || status === "success" || status === "succeeded";
  if (ready) {
    try {
      const { map } = loadWorkflowFiles(ctx.root);
      ready = Boolean(findOutput(job, map));
    } catch {
      ready = false;
    }
    if (!ready) {
      finishJob(ctx, id);
      sendOffline(res);
      return;
    }
  }
  const progress = Number(job?.progress?.value);
  sendJson(res, 200, {
    status: ready ? "completed" : (status === "queued" ? "queued" : "running"),
    ready,
    progress: Number.isFinite(progress) ? progress : null,
  });
}

import { apiRoute } from "../lib/vercel.mjs";

export default apiRoute(["GET", "HEAD"], handleStatus);
