import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.mjs";
import { isServerless } from "./session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createGate(max = 2) {
  let active = 0;
  const waiting = [];
  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    release() {
      const next = waiting.shift();
      if (next) {
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },
  };
}

export function createRuntime(options = {}) {
  const root = options.root || ROOT;
  const fileEnv = options.env ? {} : loadEnvFile(path.join(root, ".env"));
  const pick = (name) => {
    if (options.env && Object.prototype.hasOwnProperty.call(options.env, name)) {
      return String(options.env[name] ?? "");
    }
    if (process.env[name]) return String(process.env[name]);
    return fileEnv[name] ? String(fileEnv[name]) : "";
  };
  const endpoint = pick("COMFY_DEPLOYMENT_ENDPOINT").trim().replace(/\/+$/, "");
  const key = pick("COMFY_CLOUD_API_KEY").trim();
  return {
    root,
    endpoint,
    key,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    // Locally two renders run at once. On Vercel each instance is short-lived and polls may land
    // on another instance, so the gate would never release; the browser already caps itself at 2.
    gate: createGate(isServerless() ? Number.MAX_SAFE_INTEGER : 2),
    jobs: new Map(),
    offline() {
      return !endpoint || !key;
    },
  };
}

export function trackJob(ctx, jobId) {
  const timer = setTimeout(() => finishJob(ctx, jobId), 12 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  ctx.jobs.set(jobId, { timer, released: false });
}

export function finishJob(ctx, jobId) {
  const job = ctx.jobs.get(jobId);
  if (!job || job.released) return;
  job.released = true;
  clearTimeout(job.timer);
  ctx.jobs.delete(jobId);
  ctx.gate.release();
}
