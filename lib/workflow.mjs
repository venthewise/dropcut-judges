import fs from "node:fs";
import path from "node:path";

export const FPS = 24;
export const ASPECT = "9:16 (Portrait Widescreen)";

export const LOOKS = {
  neon: {
    positive: "Acid neon rim light, hard graphic shadows, night exterior, the subject of the reference still, same framing, vertical 9:16",
    negative: "blurry, watermark, text, logo, extra limbs, deformed, low detail",
  },
  film: {
    positive: "16mm film grain, warm tungsten, soft halation, slight gate weave, the subject of the reference still, same framing, vertical 9:16",
    negative: "digital smear, watermark, text, logo, plastic skin, oversharpened",
  },
  ink: {
    positive: "Bold ink contours, flat cel color, paper white gaps, the subject of the reference still. Graphic animation frame",
    negative: "photorealistic pores, watermark, text, logo, muddy color, 3d render",
  },
  glitch: {
    positive: "Datamosh slices, RGB offset, scanline tear, one frozen glitch, the subject of the reference still",
    negative: "clean commercial, watermark, text, logo, soft focus, pastel",
  },
  xerox: {
    positive: "Black and white photocopier, crushed blacks, dust, threshold poster, the subject of the reference still",
    negative: "color, watermark, text, logo, soft gradient, glossy",
  },
  chrome: {
    positive: "Liquid chrome and brushed metal highlights, hard studio light, the subject of the reference still",
    negative: "rust, watermark, text, logo, muddy, matte plastic",
  },
};

export function composePositive(lookPositive, brief) {
  const line = String(brief ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `${lookPositive}. Brief: ${line}. Use the provided start image as the first frame. No text, no black frames.`;
}

export function renderDuration(seconds, map = {}) {
  const min = Number.isFinite(Number(map.durationMinSeconds)) ? Number(map.durationMinSeconds) : 1;
  const max = Number.isFinite(Number(map.durationMaxSeconds)) ? Number(map.durationMaxSeconds) : 10;
  const n = Math.ceil(Number(seconds) - 1e-9);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function bindingList(binding) {
  if (!binding) return [];
  return Array.isArray(binding) ? binding : [binding];
}

function writeInput(graph, binding, value) {
  const node = graph[String(binding.nodeId)];
  if (!node || !node.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, binding.input)) {
    throw new Error("Workflow binding is missing");
  }
  node.inputs[binding.input] = value;
}

export function patchWorkflow(graph, map, options) {
  const next = structuredClone(graph);
  const bindings = map.bindings;
  writeInput(next, bindings.image, options.image);
  writeInput(next, bindings.positive, options.positive);
  writeInput(next, bindings.negative, options.negative);
  for (const binding of bindingList(bindings.seed)) writeInput(next, binding, options.seed);
  writeInput(next, bindings.duration, renderDuration(options.duration, map));
  writeInput(next, bindings.fps, options.fps ?? map.fps ?? FPS);
  writeInput(next, bindings.aspect, options.aspect ?? map.aspect ?? ASPECT);
  writeInput(next, bindings.enhance, true);
  return next;
}

export function loadWorkflowFiles(root) {
  const graph = JSON.parse(fs.readFileSync(path.join(root, "workflows", "ltx-i2v.api.json"), "utf8"));
  const map = JSON.parse(fs.readFileSync(path.join(root, "workflows", "ltx-i2v.map.json"), "utf8"));
  return { graph, map };
}

export function assetName(payload, fallback) {
  if (payload && typeof payload.name === "string" && payload.name.trim()) return payload.name.trim();
  if (payload && typeof payload.file_path === "string" && payload.file_path.trim()) {
    const parts = payload.file_path.split(/[/\\]/);
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return fallback;
}

export function findOutput(job, map) {
  const nodeId = String(map?.bindings?.output?.nodeId ?? "");
  const outputs = job?.outputs;
  if (!nodeId || !Array.isArray(outputs)) return null;
  const matches = outputs.filter((item) => item && String(item.node_id) === nodeId);
  return matches.find((item) => item.type === "video" || String(item.content_type || "").startsWith("video/"))
    || matches[0]
    || null;
}
