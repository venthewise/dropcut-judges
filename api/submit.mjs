import { readJson, sendJson, sendOffline } from "../lib/http.mjs";
import { submitWorkflow } from "../lib/comfy.mjs";
import { trackJob } from "../lib/runtime.mjs";
import {
  ASPECT,
  FPS,
  LOOKS,
  composePositive,
  loadWorkflowFiles,
  patchWorkflow,
} from "../lib/workflow.mjs";

function cleanBrief(value) {
  return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function cleanImage(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 240 || /[\u0000-\u001f/\\]/.test(text)) return "";
  return text;
}

function cleanSeed(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

export async function handleSubmit(req, res, ctx) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  if (ctx.offline()) {
    sendOffline(res);
    return;
  }
  const look = String(body?.look || "").toLowerCase();
  const spec = LOOKS[look];
  const image = cleanImage(body?.image);
  const seed = cleanSeed(body?.seed);
  const duration = Number(body?.duration);
  if (!spec || !image || seed == null || !Number.isFinite(duration)) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  let graph;
  let map;
  try {
    const files = loadWorkflowFiles(ctx.root);
    graph = files.graph;
    map = files.map;
  } catch {
    sendOffline(res);
    return;
  }
  let workflow;
  try {
    workflow = patchWorkflow(graph, map, {
      image,
      positive: composePositive(spec.positive, cleanBrief(body?.brief)),
      negative: spec.negative,
      seed,
      duration,
      fps: FPS,
      aspect: ASPECT,
      enhance: true,
    });
  } catch {
    sendOffline(res);
    return;
  }
  await ctx.gate.acquire();
  try {
    const job = await submitWorkflow({
      endpoint: ctx.endpoint,
      key: ctx.key,
      workflow,
      fetchImpl: ctx.fetchImpl,
    });
    trackJob(ctx, job.id);
    sendJson(res, 200, { id: job.id });
  } catch {
    ctx.gate.release();
    sendOffline(res);
  }
}

import { apiRoute } from "../lib/vercel.mjs";

export default apiRoute(["POST"], handleSubmit);
