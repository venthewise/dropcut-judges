import { analyzeWindow, buildCutList, LENGTHS, MAX_PHOTOS, photoRuleError } from "./lib/cuts.mjs";

const D = window.DROPCUT_DATA;
const $ = (s) => document.querySelector(s);
const MAX_PHOTO = 25 * 1024 * 1024;
const MAX_SONG = 20 * 1024 * 1024;
const FADE_OUT = 0.5;
const LOOKS = {
  film: "16MM FILM",
  neon: "ACID NEON",
  ink: "INK",
  glitch: "GLITCH",
  xerox: "XEROX",
  chrome: "CHROME",
};
const CAPS = { promo: "PROMO", kick: "ON THE KICK", lower: "LOWER THIRD", block: "BLOCK", stamp: "STAMP" };
const CAP_COLORS = [
  ["auto", "Style"],
  ["#d1fe17", "Acid"],
  ["#0a0a0a", "Ink"],
  ["#f4f1ea", "White"],
  ["#e0002a", "Red"],
  ["transparent", "None"],
];
const CAP_DEFAULT = { lower: "#0a0a0a", promo: "#d1fe17", block: "#d1fe17", stamp: "#d1fe17", kick: "#d1fe17" };
let capColor = "auto";
const CAP_SIZES = [["s", "S", 0.75], ["m", "M", 1], ["l", "L", 1.25], ["xl", "XL", 1.5]];
const CAP_ALIGNS = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
const CAP_SAFE = 64;
let capSize = "m";
let capAlign = "center";
function inkOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0a0a0a" : "#f4f1ea";
}
function capPaint(style, color = capColor) {
  if (color === "transparent") return { box: null, text: "#f4f1ea", outline: "#0a0a0a" };
  const box = color === "auto" ? CAP_DEFAULT[style] || "#d1fe17" : color;
  const text = style === "lower" && color === "auto" ? "#f4f1ea" : inkOn(box);
  return { box, text, outline: null };
}
const TRANS = { hard: "HARD CUT", flash: "FLASH", whip: "WHIP PAN" };
const NAMES = { cafe: "Café", gig: "Gig", listing: "Listing" };
const SAMPLE_NOTE = "Samples play reels the engine already rendered. Real renders each photo, then stitches the reel in the browser.";
const REAL_NOTE = "Real mode renders each photo, then stitches the reel here. Pick a reel length of 5, 10, 15, 30 or 60 seconds.";

const frames = $(".js-frames");
const specs = $(".js-specs");
const wave = $(".js-wave");
const video = $(".js-video");
const ph = $(".js-placeholder");
const phImg = $(".js-ph-img");
const bar = $(".js-bar");
const log = $(".js-log");
const gen = $(".js-generate");
const dl = $(".js-download");
const songBtn = $(".js-song");
const waveTime = $(".js-wavetime");
const waveInfo = $(".js-waveinfo");
const note = $(".js-note");
const realBox = $(".js-real");
const cancelBtn = $(".js-cancel");
const stepEls = document.querySelectorAll(".js-step");
const capPicker = $(".js-cap-picker");
const capSelect = $(".js-cap");
const capThumbs = {};
let capBg = null;
let capBgUrl = "";
const sampleBar = $(".js-samples");
const song = new Audio("media/song.m4a");
song.preload = "auto";

let mode = "samples";
let preset = "cafe";
let running = false;
let timer = null;
let downloadUrl = "";
let analysisToken = 0;
let songToken = 0;
let ffmpegPromise = null;
let fontPromise = null;
let abortCtl = null;

function showSteps(on) {
  stepEls.forEach((el) => { el.hidden = !on; });
}

function cancelled() {
  const err = knownError("generation cancelled");
  err.cancelled = true;
  return err;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelled());
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(id); reject(cancelled()); }, { once: true });
  });
}

const real = {
  photos: [],
  songMode: "sample15",
  songBytes: null,
  songName: "song.m4a",
  sampleBytes: null,
  decoded: null,
  windowStart: 0,
  windowLen: 15,
  songDuration: null,
  uploadBytes: null,
  uploadName: "song.audio",
  uploadToken: 0,
  brief: "",
  captionStyle: "block",
  transition: "hard",
  baseSeed: 1,
  analysis: null,
  touched: false,
};

const fmt = (t) => {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.max(0, t) - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};
const tc = (t) => {
  const f = Math.floor(t * 24);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(f / 86400))}:${p(Math.floor(f / 1440) % 60)}:${p(Math.floor(f / 24) % 60)}:${p(f % 24)}`;
};
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[ch]));

function sheetModel() {
  if (mode === "real") {
    const analysis = real.analysis;
    return {
      bpm: analysis?.bpm || 120,
      beatStart: analysis?.beats?.[0] || 0,
      duration: analysis?.window || real.windowLen,
      peaks: analysis?.peaks || [],
      segments: analysis?.segments || [],
      captionStyle: real.captionStyle,
      transition: real.transition,
    };
  }
  const current = D.presets[preset];
  return {
    bpm: D.bpm,
    duration: D.duration,
    peaks: D.peaks,
    segments: current.segments,
    captionStyle: current.captionStyle,
    transition: current.transition,
  };
}

function infoLine(model) {
  const beat = 60 / model.bpm;
  const bars = model.segments.map((segment) => Math.round(segment.start / (beat * 4)));
  const bpm = Math.round(model.bpm);
  return `${bpm} BPM · ${model.segments.length} CUTS · BARS ${bars.join(" · ")}`;
}

function paintSpecs(model = sheetModel()) {
  const looks = [...new Set(model.segments.map((segment) => LOOKS[segment.look] || (segment.look ? String(segment.look).toUpperCase() : "")))].filter(Boolean);
  if (mode === "real" && real.photos.length) {
    const chosen = [...new Set(real.photos.map((photo) => LOOKS[photo.look] || photo.look.toUpperCase()))];
    looks.splice(0, looks.length, ...chosen);
  }
  const rows = [
    ["LOOK", looks.join(" / ") || "—"],
    ["CAPTIONS", CAPS[model.captionStyle] || model.captionStyle],
    ["TRANSITION", TRANS[model.transition] || model.transition],
    ["LENGTH", `${(model.segments.at(-1)?.end ?? model.duration).toFixed(2)}S · 9:16`],
  ];
  specs.innerHTML = rows.map(([key, value]) => `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`).join("");
  if (waveInfo) waveInfo.textContent = model.segments.length ? infoLine(model) : `${Math.round(model.bpm)} BPM · WINDOW ${model.duration.toFixed(2)}S`;
}

function renderSheet() {
  const current = D.presets[preset];
  frames.style.gridTemplateColumns = "";
  frames.innerHTML = current.segments.map((segment, i) => `
      <figure data-i="${i}">
        <img src="media/${segment.photo}.webp" alt="${esc(NAMES[preset])} photo ${i + 1}" width="144" height="256" loading="eager">
        <i class="cue">${esc(segment.cue)}</i>
        <figcaption>
          <b><span>A${i + 1}</span><span>${segment.start.toFixed(2)}s → ${segment.end.toFixed(2)}s</span></b>
          <span>${esc(LOOKS[segment.look] || segment.look.toUpperCase())}</span>
          <span title="${esc(segment.caption)}">“${esc(segment.caption)}”</span>
        </figcaption>
      </figure>`).join("");
  paintSpecs();
  phImg.src = `media/${current.segments[0].photo}.webp`;
  waveTime.textContent = `00:00.00 / ${fmt(D.duration)}`;
  drawWave();
}

function capPreviewText() {
  const first = real.photos.find((photo) => String(photo.caption || "").trim());
  return first ? first.caption : "Your caption here";
}

const capColorRow = $(".js-cap-colors");
function buildCapColors() {
  if (!capColorRow || capColorRow.querySelector("button")) return;
  for (const [value, label] of CAP_COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.color = value;
    btn.title = label;
    const dot = document.createElement("i");
    if (value === "auto") dot.className = "auto";
    else if (value === "transparent") dot.className = "none";
    else dot.style.background = value;
    const name = document.createElement("span");
    name.textContent = label;
    btn.append(dot, name);
    btn.addEventListener("click", () => { if (!running) setCapColor(value); });
    capColorRow.append(btn);
  }
  const custom = document.createElement("label");
  custom.className = "custom";
  custom.title = "Custom color";
  const input = document.createElement("input");
  input.type = "color";
  input.value = "#3b82f6";
  input.className = "js-cap-custom";
  input.addEventListener("input", () => { if (!running) setCapColor(input.value); });
  const name = document.createElement("span");
  name.textContent = "Custom";
  custom.append(input, name);
  capColorRow.append(custom);
}
const capSizeRow = $(".js-cap-size");
const capAlignRow = $(".js-cap-align");
function buildChoiceRow(row, items, onPick) {
  if (!row || row.querySelector("button")) return;
  for (const [value, label] of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.value = value;
    btn.textContent = label;
    btn.addEventListener("click", () => { if (!running) { onPick(value); paintCapPicker(); } });
    row.append(btn);
  }
}
function markRow(row, current) {
  if (row) for (const btn of row.querySelectorAll("button")) btn.setAttribute("aria-checked", String(btn.dataset.value === current));
}
function setCapColor(value) {
  capColor = value;
  real.captionColor = value;
  paintCapPicker();
}

async function paintCapPicker() {
  if (!capPicker) return;
  buildCapColors();
  buildChoiceRow(capSizeRow, CAP_SIZES, (v) => { capSize = v; real.captionSize = v; });
  buildChoiceRow(capAlignRow, CAP_ALIGNS, (v) => { capAlign = v; real.captionAlign = v; });
  markRow(capSizeRow, capSize);
  markRow(capAlignRow, capAlign);
  if (capColorRow) {
    const preset = CAP_COLORS.some(([v]) => v === capColor);
    for (const btn of capColorRow.querySelectorAll("button")) btn.setAttribute("aria-checked", String(btn.dataset.color === capColor));
    capColorRow.querySelector(".custom").setAttribute("aria-checked", String(!preset));
  }
  if (!capPicker.childElementCount) {
    for (const [value, label] of Object.entries(CAPS)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.dataset.cap = value;
      const canvas = document.createElement("canvas");
      canvas.width = 216;
      canvas.height = 384;
      const name = document.createElement("span");
      name.textContent = label;
      btn.append(canvas, name);
      btn.addEventListener("click", () => {
        if (running) return;
        capSelect.value = value;
        capSelect.dispatchEvent(new Event("input"));
        paintCapPicker();
      });
      capPicker.append(btn);
      capThumbs[value] = canvas;
    }
  }
  const url = real.photos[0] ? real.photos[0].url : "media/cafe-1-latte.webp";
  if (url !== capBgUrl) {
    capBgUrl = url;
    capBg = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  try { await loadFont(); } catch { /* falls back to the default font */ }
  const text = capPreviewText();
  const layer = document.createElement("canvas");
  layer.width = 1080;
  layer.height = 1920;
  const lctx = layer.getContext("2d");
  for (const [value, canvas] of Object.entries(capThumbs)) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (capBg) {
      const scale = Math.max(canvas.width / capBg.width, canvas.height / capBg.height);
      const w = capBg.width * scale;
      const h = capBg.height * scale;
      ctx.drawImage(capBg, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }
    lctx.clearRect(0, 0, 1080, 1920);
    drawCaption(lctx, text, value);
    ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
    canvas.parentElement.setAttribute("aria-checked", String(capSelect.value === value));
  }
}

let dragFrom = -1;
function movePhoto(from, to) {
  if (running || from === to || from < 0 || to < 0 || from >= real.photos.length || to >= real.photos.length) return;
  const [photo] = real.photos.splice(from, 1);
  real.photos.splice(to, 0, photo);
  renderRealCards();
}

function renderRealCards() {
  frames.replaceChildren();
  if (!real.photos.length) {
    frames.style.gridTemplateColumns = "";
    const empty = document.createElement("p");
    empty.className = "empty-shots";
    empty.textContent = "Add 5 photos (5 to 10 for 30 s, 10 for 60 s).";
    frames.append(empty);
    phImg.removeAttribute("src");
    paintSpecs();
    drawWave();
    return;
  }
  frames.style.gridTemplateColumns = `repeat(${Math.min(real.photos.length, 5)}, minmax(0, 1fr))`;
  real.photos.forEach((photo, i) => {
    const fig = document.createElement("figure");
    fig.dataset.i = String(i);
    fig.draggable = true;
    fig.title = "Drag to reorder";
    fig.addEventListener("dragstart", (e) => {
      if (running || e.target.closest("input, select")) { e.preventDefault(); return; }
      dragFrom = i;
      fig.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    });
    fig.addEventListener("dragend", () => { fig.classList.remove("dragging"); dragFrom = -1; });
    fig.addEventListener("dragover", (e) => { if (dragFrom >= 0) { e.preventDefault(); fig.classList.add("drop"); } });
    fig.addEventListener("dragleave", () => fig.classList.remove("drop"));
    fig.addEventListener("drop", (e) => { e.preventDefault(); fig.classList.remove("drop"); movePhoto(dragFrom, i); });
    const order = document.createElement("div");
    order.className = "order";
    for (const [dir, glyph, label] of [[-1, "\u2190", "earlier"], [1, "\u2192", "later"]]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = glyph;
      btn.setAttribute("aria-label", `Move photo ${i + 1} ${label}`);
      btn.disabled = i + dir < 0 || i + dir >= real.photos.length;
      btn.addEventListener("click", () => movePhoto(i, i + dir));
      order.append(btn);
    }
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = `Photo ${i + 1}`;
    img.width = 144;
    img.height = 256;
    const cue = document.createElement("i");
    cue.className = "cue";
    cue.textContent = "HOLD";
    const cap = document.createElement("figcaption");
    const title = document.createElement("b");
    const label = document.createElement("span");
    label.textContent = `A${i + 1}`;
    const time = document.createElement("span");
    time.className = "js-shot-time";
    time.textContent = "—";
    title.append(label, time);
    const fields = document.createElement("div");
    fields.className = "shot-fields";
    const look = document.createElement("select");
    look.setAttribute("aria-label", `Look for photo ${i + 1}`);
    for (const [value, text] of Object.entries(LOOKS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = value === photo.look;
      look.append(option);
    }
    look.addEventListener("change", () => {
      photo.look = look.value;
      paintSpecs();
    });
    const caption = document.createElement("input");
    caption.type = "text";
    caption.maxLength = 72;
    caption.placeholder = "Caption";
    caption.value = photo.caption;
    caption.setAttribute("aria-label", `Caption for photo ${i + 1}`);
    caption.addEventListener("input", () => {
      photo.caption = caption.value;
      paintCapPicker();
    });
    fields.append(look, caption);
    cap.append(title, fields);
    fig.append(img, cue, order, cap);
    frames.append(fig);
  });
  phImg.src = real.photos[0].url;
  paintCapPicker();
  paintTimes();
  paintSpecs();
  drawWave();
}

function paintTimes() {
  const segments = real.analysis?.segments || [];
  frames.querySelectorAll("figure").forEach((fig, i) => {
    const segment = segments[i];
    if (!segment) return;
    const time = fig.querySelector(".js-shot-time");
    const cue = fig.querySelector(".cue");
    if (time) time.textContent = `${segment.start.toFixed(2)}s → ${segment.end.toFixed(2)}s`;
    if (cue) cue.textContent = segment.cue;
  });
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function drawWave() {
  const model = sheetModel();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const rect = wave.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (wave.width !== w || wave.height !== h) {
    wave.width = w;
    wave.height = h;
  }
  const ctx = wave.getContext("2d");
  const total = model.duration || 1;
  const xAt = (t) => (t / total) * w;
  const beat = 60 / model.bpm;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const ink = dark ? cssColor("--ink", "#f4f1ea") : "#0a0a0a";
  ctx.fillStyle = dark ? cssColor("--panel", "#1c1b17") : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ink;
  const offset = (((model.beatStart || 0) % beat) + beat) % beat;
  for (let i = 0, t = offset; t < total; i += 1, t = offset + i * beat) {
    const downbeat = i % 4 === 0;
    ctx.globalAlpha = downbeat ? 0.35 : 0.12;
    ctx.fillRect(Math.round(xAt(t)), downbeat ? 0 : h * 0.8, dpr, downbeat ? h : h * 0.2);
  }
  ctx.globalAlpha = 1;
  const peaks = model.peaks.length ? model.peaks : [0.2];
  const bw = w / peaks.length;
  const mid = h * 0.5;
  const played = playhead(total);
  const dim = dark ? cssColor("--muted", "#c8c3b8") : "#8a8a8a";
  peaks.forEach((peak, i) => {
    const t = (i / peaks.length) * total;
    const amp = Math.max(1, peak * h * 0.42);
    ctx.fillStyle = played >= t ? ink : dim;
    ctx.fillRect(i * bw, mid - amp, Math.max(1, bw - dpr), amp * 2);
  });
  ctx.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
  model.segments.forEach((segment, i) => {
    const x = xAt(segment.start);
    ctx.fillStyle = "#d1fe17";
    ctx.fillRect(x, 0, 4 * dpr, h);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(x, 0, 1 * dpr, h);
    ctx.fillRect(x + 4 * dpr, 2 * dpr, 30 * dpr, 15 * dpr);
    ctx.fillStyle = "#d1fe17";
    ctx.fillText(`A${i + 1}`, x + 7 * dpr, 14 * dpr);
  });
  if (played >= 0) {
    ctx.fillStyle = "#e0002a";
    ctx.fillRect(xAt(played), 0, 2 * dpr, h);
  }
}

window.addEventListener("dropcut-theme", () => drawWave());

function playhead(total) {
  if (mode === "samples") return song.paused && !song.currentTime ? -1 : song.currentTime;
  if (!real.touched && song.paused) return -1;
  const rel = song.currentTime - real.windowStart;
  if (rel < 0) return -1;
  return Math.min(rel, total);
}

function highlight(t) {
  const segments = sheetModel().segments;
  const idx = segments.findIndex((segment) => t >= segment.start && t < segment.end);
  frames.querySelectorAll("figure").forEach((fig, i) => fig.classList.toggle("live", i === idx));
}

function songLoop() {
  const model = sheetModel();
  if (mode === "real" && song.currentTime >= real.windowStart + model.duration) {
    song.pause();
    songBtn.textContent = "▶ Play song";
  }
  drawWave();
  highlight(playhead(model.duration));
  const shown = mode === "real" ? Math.max(0, song.currentTime - real.windowStart) : song.currentTime;
  waveTime.textContent = `${fmt(shown)} / ${fmt(model.duration)}`;
  if (!song.paused) requestAnimationFrame(songLoop);
}

songBtn.addEventListener("click", () => {
  if (song.paused) {
    video.pause();
    if (mode === "real") {
      real.touched = true;
      const end = real.windowStart + sheetModel().duration;
      if (song.currentTime < real.windowStart || song.currentTime >= end) song.currentTime = real.windowStart;
    }
    song.play().then(songLoop).catch(() => {});
    songBtn.textContent = "❚❚ Pause";
  } else {
    song.pause();
    songBtn.textContent = "▶ Play song";
  }
});
song.addEventListener("ended", () => {
  songBtn.textContent = "▶ Play song";
  song.currentTime = mode === "real" ? real.windowStart : 0;
  highlight(-1);
  drawWave();
});
wave.addEventListener("click", (e) => {
  const model = sheetModel();
  const rect = wave.getBoundingClientRect();
  const pos = ((e.clientX - rect.left) / rect.width) * model.duration;
  if (mode === "real") {
    real.touched = true;
    song.currentTime = real.windowStart + pos;
  } else {
    song.currentTime = pos;
  }
  drawWave();
  highlight(pos);
  waveTime.textContent = `${fmt(pos)} / ${fmt(model.duration)}`;
});

function pushLog(message) {
  log.insertAdjacentHTML("beforeend", `<li>&gt; ${esc(message)}</li>`);
  while (log.children.length > 5) log.firstElementChild.remove();
}

function clearPlayback() {
  video.pause();
  video.hidden = true;
  video.removeAttribute("src");
  video.load();
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = "";
  }
  ph.hidden = false;
  dl.hidden = true;
  dl.removeAttribute("href");
  bar.style.width = "0";
}

function reset() {
  clearTimeout(timer);
  running = false;
  clearPlayback();
  gen.disabled = false;
  gen.textContent = "Generate";
  if (mode === "real") {
    const count = real.photos.length;
    log.innerHTML = `<li class="dim">&gt; real brief loaded · ${count} photo${count === 1 ? "" : "s"} · 1 song</li>`;
    paintGate();
  } else {
    log.innerHTML = `<li class="dim">&gt; ${esc(NAMES[preset].toLowerCase())} brief loaded · 5 photos · 1 song</li>`;
    gen.title = "";
    const gate = $(".js-gate");
    if (gate) gate.hidden = true;
  }
}

document.querySelectorAll(".presets button[data-preset]").forEach((button) => button.addEventListener("click", () => {
  if (running || button.dataset.preset === preset) return;
  document.querySelectorAll(".presets button[data-preset]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  preset = button.dataset.preset;
  song.pause();
  song.currentTime = 0;
  songBtn.textContent = "▶ Play song";
  renderSheet();
  reset();
}));

document.querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", () => {
  if (running || button.dataset.source === mode) return;
  mode = button.dataset.source;
  document.querySelectorAll("[data-source]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  const realOn = mode === "real";
  realBox.hidden = !realOn;
  showSteps(realOn);
  sampleBar.hidden = realOn;
  song.pause();
  songBtn.textContent = "▶ Play song";
  real.touched = false;
  if (!realOn) {
    if (real.songObjectUrl) URL.revokeObjectURL(real.songObjectUrl);
    song.src = "media/song.m4a";
    song.currentTime = 0;
    note.classList.remove("warn");
    note.textContent = SAMPLE_NOTE;
    renderSheet();
    reset();
    return;
  }
  song.currentTime = 0;
  note.classList.remove("warn");
  note.textContent = REAL_NOTE;
  renderRealCards();
  paintCapPicker();
  reset();
  checkRenderer();
  ensureSong().then(() => refreshAnalysis()).catch(() => pushLog("Could not read the song."));
}));

function readRealForm() {
  const len = Number($(".js-window").value);
  const start = Number($(".js-window-start").value);
  real.windowLen = LENGTHS.includes(len) ? len : 15;
  real.windowStart = Math.max(0, Number.isFinite(start) ? start : 0);
  real.brief = $(".js-brief").value.replace(/\s+/g, " ").trim();
  real.captionStyle = $(".js-cap").value;
  real.transition = $(".js-trans").value;
  real.songMode = $(".js-song-mode").value;
}

function photoType(file) {
  const type = String(file.type || "").toLowerCase();
  if (type === "image/jpg" || type === "image/jpeg") return "image/jpeg";
  if (type === "image/png" || type === "image/webp") return type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

function extFor(type) {
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  return ".jpg";
}

$(".js-photos").addEventListener("change", () => {
  const picked = [...$(".js-photos").files];
  for (const photo of real.photos) URL.revokeObjectURL(photo.url);
  const photos = [];
  for (const file of picked) {
    if (photos.length >= MAX_PHOTOS) {
      pushLog(`Using the first ${MAX_PHOTOS} photos.`);
      break;
    }
    const type = photoType(file);
    if (!type) {
      pushLog("Skipped a file that is not jpg, png, or webp.");
      continue;
    }
    if (file.size > MAX_PHOTO) {
      pushLog("Skipped a photo over 25 MB.");
      continue;
    }
    photos.push({ file, type, url: URL.createObjectURL(file), look: "film", caption: "" });
  }
  real.photos = photos;
  real.baseSeed = 1;
  renderRealCards();
  paintGate();
  refreshAnalysis().catch(() => {});
});

$(".js-song-mode").addEventListener("change", () => {
  readRealForm();
  $(".js-audio-label").hidden = real.songMode !== "upload";
  real.songDuration = null;
  if (real.songMode === "upload") {
    if (real.uploadBytes) {
      if (real.songObjectUrl) song.src = real.songObjectUrl;
      ensureSong().then(() => refreshAnalysis()).catch(() => pushLog("Could not read the song."));
    } else paintGate();
  }
  if (real.songMode.startsWith("sample")) {
    real.sampleBytes = null;
    song.src = sampleUrl();
    ensureSong().then(() => refreshAnalysis()).catch(() => pushLog("Could not read the song."));
  }
});

$(".js-audio").addEventListener("change", () => {
  const file = $(".js-audio").files?.[0];
  if (!file) return;
  if (file.size > MAX_SONG) {
    $(".js-audio").value = "";
    pushLog(`That song is ${(Math.ceil((file.size / 1048576) * 10) / 10).toFixed(1)} MB · the limit is 20 MB. Try an mp3 or m4a.`);
    return;
  }
  file.arrayBuffer().then((buf) => {
    songToken += 1;
    real.uploadBytes = new Uint8Array(buf);
    real.uploadName = file.name || "song.audio";
    real.songBytes = real.uploadBytes;
    real.songName = real.uploadName;
    real.decoded = null;
    real.songDuration = null;
    if (real.songObjectUrl) URL.revokeObjectURL(real.songObjectUrl);
    real.songObjectUrl = URL.createObjectURL(file);
    song.src = real.songObjectUrl;
    songToken += 0;
    real.songToken = songToken;
    real.uploadToken = songToken;
    return refreshAnalysis();
  }).catch(() => pushLog("Could not read the song."));
});

for (const selector of [".js-window", ".js-window-start", ".js-cap", ".js-trans", ".js-brief"]) {
  $(selector).addEventListener(selector === ".js-window" ? "change" : "input", () => {
    readRealForm();
    if (selector === ".js-window" || selector === ".js-window-start") paintGate();
    if (selector === ".js-cap" || selector === ".js-trans") paintSpecs();
    if (selector === ".js-cap") paintCapPicker();
    if (selector === ".js-window" || selector === ".js-window-start") {
      refreshAnalysis().catch(() => {});
    }
  });
}

async function checkRenderer() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      note.classList.add("warn");
      note.textContent = "Renderer is offline";
      return false;
    }
    if (note.textContent === "Renderer is offline") {
      note.classList.remove("warn");
      note.textContent = REAL_NOTE;
    }
    return true;
  } catch {
    note.classList.add("warn");
    note.textContent = "Renderer is offline";
    return false;
  }
}

const SAMPLE_SONGS = { sample15: 15, sample30: 30, sample60: 60 };
function sampleSeconds() { return SAMPLE_SONGS[real.songMode] || 15; }
function sampleUrl() { return `media/song-${sampleSeconds()}s.m4a`; }

async function ensureSong() {
  readRealForm();
  if (real.songMode === "upload") {
    if (!real.uploadBytes) throw knownError("Choose an audio file for the song.");
    real.songBytes = real.uploadBytes;
    real.songName = real.uploadName;
    real.songToken = real.uploadToken;
    return;
  }
  if (!real.sampleBytes || real.sampleFor !== real.songMode) {
    real.sampleFor = real.songMode;
    const res = await fetch(sampleUrl());
    if (!res.ok) throw knownError("Could not read the song.");
    real.sampleBytes = new Uint8Array(await res.arrayBuffer());
  }
  real.songBytes = real.sampleBytes;
  real.songName = sampleUrl().split("/").pop();
  real.songToken = -sampleSeconds();
}

async function decodeSong(bytes, token) {
  if (real.decoded && real.decoded.token === token) return real.decoded.audio;
  const ctx = new AudioContext();
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audio = await ctx.decodeAudioData(copy);
    real.decoded = { token, audio };
    return audio;
  } finally {
    await ctx.close();
  }
}

function windowSamples(audio, start, len) {
  const sr = audio.sampleRate;
  const i0 = Math.max(0, Math.floor(start * sr));
  const i1 = Math.min(audio.length, Math.floor((start + len) * sr));
  const n = Math.max(0, i1 - i0);
  const out = new Float32Array(n);
  const left = audio.getChannelData(0);
  const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  for (let i = 0; i < n; i += 1) {
    const a = left[i0 + i];
    const b = right ? right[i0 + i] : a;
    out[i] = (a + b) * 0.5;
  }
  return out;
}

async function refreshAnalysis() {
  if (mode !== "real") return;
  const token = ++analysisToken;
  await ensureSong();
  const bytes = real.songBytes;
  const songId = real.songToken;
  let audio;
  try {
    audio = await decodeSong(bytes, songId);
  } catch (err) {
    if (err && err.known) throw err;
    throw knownError("Could not read the song.");
  }
  if (token !== analysisToken || mode !== "real") return;
  readRealForm();
  real.songDuration = audio.duration;
  paintGate();
  const fits = audio.duration - real.windowStart >= real.windowLen - 0.001;
  const analyzeStart = Math.min(real.windowStart, Math.max(0, audio.duration - 0.35));
  const len = fits ? real.windowLen : Math.min(real.windowLen, Math.max(0.35, audio.duration - analyzeStart));
  const samples = windowSamples(audio, analyzeStart, len);
  const heard = analyzeWindow(samples, audio.sampleRate);
  let segments = [];
  if (real.photos.length) {
    const cuts = buildCutList({
      beats: heard.beats,
      duration: fits ? real.windowLen : heard.duration || len,
      photoCount: real.photos.length,
      drop: heard.drop,
      baseSeed: real.baseSeed,
    });
    segments = cuts.segments.map((segment, i) => ({
      ...segment,
      look: real.photos[i].look,
    }));
  }
  if (token !== analysisToken || mode !== "real") return false;
  real.analysis = {
    bpm: heard.bpm,
    beats: heard.beats,
    drop: heard.drop,
    peaks: heard.peaks,
    window: fits ? real.windowLen : heard.duration || len,
    segments,
  };
  paintTimes();
  paintSpecs();
  drawWave();
  waveTime.textContent = `00:00.00 / ${fmt(real.analysis.window)}`;
  return true;
}

function fmtStart(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.abs(rest - Math.round(rest)) < 0.05;
  return `${m}:${(whole ? String(Math.round(rest)) : rest.toFixed(1)).padStart(whole ? 2 : 4, "0")}`;
}

// One-line reason Generate is blocked in Real mode, or "" when the brief fits.
function realBlock() {
  const count = real.photos.length;
  const len = real.windowLen;
  if (!count) return photoRuleError(len, 0).replace(" · you have 0.", ". Add photos to start.");
  const photoErr = photoRuleError(len, count);
  if (photoErr) return photoErr;
  if (real.songMode === "upload" && !real.uploadBytes) return "Choose an audio file for the song.";
  if (real.songDuration == null) return "Reading the song…";
  const left = real.songDuration - real.windowStart;
  if (left < len - 0.001) {
    if (real.songMode.startsWith("sample") && real.windowStart < 0.001) {
      return `Sample song · ${sampleSeconds()} s is too short for a ${len} s reel · pick Sample song · ${len} s.`;
    }
    return `Song is too short for ${len} s from ${fmtStart(real.windowStart)} (${Math.max(0, left).toFixed(1)} s left) · pick an earlier start or a shorter length.`;
  }
  return "";
}

function paintGate() {
  const gate = $(".js-gate");
  if (mode !== "real") {
    if (gate) gate.hidden = true;
    return "";
  }
  readRealForm();
  const why = realBlock();
  if (gate) {
    gate.hidden = !why;
    gate.textContent = why ? `Generate is locked · ${why}` : "";
  }
  if (!running) gen.disabled = Boolean(why);
  gen.title = why;
  return why;
}

function knownError(message) {
  const err = new Error(message);
  err.known = true;
  return err;
}

// Hosted functions accept at most 4.5 MB per request, so large photos are resized in the
// browser first (long side 1920 px, JPEG quality stepping down) until they fit under 3.5 MB.
// Songs never leave the browser; they only feed the in-browser stitch.
const UPLOAD_TARGET = 3.5 * 1024 * 1024;
const UPLOAD_LONG_SIDE = 1920;

function canvasBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function uploadablePhoto(shot) {
  if (shot.file.size <= UPLOAD_TARGET) return { body: shot.file, type: shot.type };
  pushLog(`resizing A${shot.index + 1}`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(shot.file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(shot.file).catch(() => null);
  }
  if (!bitmap) throw knownError("Could not read a photo. Try a jpg or png.");
  try {
    let longSide = UPLOAD_LONG_SIDE;
    for (let pass = 0; pass < 4; pass += 1) {
      const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob && blob.size <= UPLOAD_TARGET) return { body: blob, type: "image/jpeg" };
      }
      longSide = Math.round(longSide * 0.75);
    }
  } finally {
    bitmap.close?.();
  }
  throw knownError("Could not shrink a photo enough to upload. Try a smaller photo.");
}

async function postShot(shot, brief, signal) {
  if (signal.aborted) throw cancelled();
  const photo = await uploadablePhoto(shot);
  if (signal.aborted) throw cancelled();
  pushLog(`uploading A${shot.index + 1}`);
  const uploaded = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": photo.type,
      "X-Filename": `shot-${shot.index + 1}${extFor(photo.type)}`,
    },
    body: photo.body,
    signal,
  });
  const uploadBody = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok) throw knownError(uploadBody.error || "Renderer is offline");
  pushLog(`rendering A${shot.index + 1}`);
  const submitted = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: uploadBody.name,
      look: shot.look,
      brief,
      seed: shot.seed,
      duration: shot.end - shot.start,
    }),
    signal,
  });
  const submitBody = await submitted.json().catch(() => ({}));
  if (!submitted.ok) throw knownError(submitBody.error || "Renderer is offline");
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 12 * 60 * 1000) {
    const status = await fetch(`/api/status?id=${encodeURIComponent(submitBody.id)}`, { signal });
    const state = await status.json().catch(() => ({}));
    if (!status.ok || state.error) throw knownError(state.error || "Renderer is offline");
    if (state.ready) {
      ready = true;
      break;
    }
    await wait(2000, signal);
  }
  if (!ready) throw knownError("Renderer is offline");
  pushLog(`fetching A${shot.index + 1}`);
  const file = await fetch(`/api/file?id=${encodeURIComponent(submitBody.id)}`, { signal });
  if (!file.ok) throw knownError("Renderer is offline");
  return new Uint8Array(await file.arrayBuffer());
}

async function mapPool(items, limit, fn) {
  const queue = items.slice();
  let failure = null;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length && !failure) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (err) {
        failure = err;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

function loadFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const face = new FontFace("Anton", "url(/vendor/fonts/Anton-Regular.ttf)");
      await face.load();
      document.fonts.add(face);
    })().catch((err) => {
      fontPromise = null;
      throw err;
    });
  }
  return fontPromise;
}

function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (!globalThis.FFmpegWASM) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/vendor/ffmpeg/ffmpeg.js";
          script.onload = () => resolve();
          script.onerror = () => reject(knownError("Could not stitch the reel: the stitcher script did not load."));
          document.head.appendChild(script);
        });
      }
      const ffmpeg = new globalThis.FFmpegWASM.FFmpeg();
      const origin = location.origin;
      try {
        await ffmpeg.load({
          coreURL: `${origin}/vendor/ffmpeg/ffmpeg-core.js`,
          wasmURL: `${origin}/vendor/ffmpeg/ffmpeg-core.wasm`,
        });
      } catch (err) {
        console.error("ffmpeg load failed", err);
        throw knownError(`Could not stitch the reel: the stitcher did not load (${(err && err.message) || err}).`);
      }
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

function wrapCaption(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawCaption(ctx, text, style, color = capColor, sizeKey = capSize, align = capAlign) {
  const caption = String(text || "").replace(/\s+/g, " ").trim().slice(0, 72);
  if (!caption) return;
  ctx.clearRect(0, 0, 1080, 1920);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const scale = (CAP_SIZES.find(([k]) => k === sizeKey) || CAP_SIZES[1])[2];
  const boxed = style === "block" || style === "stamp";
  const pad = boxed ? (style === "stamp" ? 36 : 32) : 0;
  const safe = CAP_SAFE + (style === "stamp" ? 24 : 0);
  // Text never gets closer than the safe margin to either side of the frame.
  const maxText = 1080 - safe * 2 - pad * 2;
  let size = Math.round((style === "kick" ? 128 : 88) * scale);
  let lines;
  for (;;) {
    ctx.font = `${size}px Anton`;
    lines = wrapCaption(ctx, caption, maxText);
    const widest = Math.max(...caption.split(" ").map((word) => ctx.measureText(word).width));
    if ((widest <= maxText && lines.join(" ") === caption) || size <= 40) break;
    size = Math.round(size * 0.92);
  }
  const lineH = size + 16;
  const textW = Math.min(maxText, Math.max(...lines.map((line) => ctx.measureText(line).width)));
  const paint = capPaint(style, color);
  const stroke = style === "kick" ? Math.max(8, Math.round(12 * scale)) : Math.max(6, Math.round(10 * scale));
  ctx.textAlign = align;
  // x for text inside a span [left, right]
  const tx = (left, right) => (align === "left" ? left : align === "right" ? right : (left + right) / 2);
  const say = (line, x, y, fill, outline = paint.outline) => {
    if (outline) {
      ctx.lineWidth = stroke;
      ctx.strokeStyle = outline;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, y);
  };
  if (style === "lower" || style === "promo") {
    const h = lines.length * lineH + (style === "lower" ? 48 : 28);
    const y = style === "lower" ? 1920 - h - 90 : 140;
    if (paint.box) { ctx.fillStyle = paint.box; ctx.fillRect(0, y, 1080, h); }
    const x = tx(safe, 1080 - safe);
    const top = y + (style === "lower" ? 24 : 14) + lineH / 2;
    lines.forEach((line, i) => say(line, x, top + i * lineH, paint.text));
    return;
  }
  if (style === "kick") {
    const fill = paint.box || "#f4f1ea";
    const x = tx(safe, 1080 - safe);
    lines.forEach((line, i) => say(line, x, 760 + i * (lineH + 8), fill, paint.outline || inkOn(fill)));
    return;
  }
  const w = textW + pad * 2;
  const h = lines.length * lineH + 36;
  const boxX = align === "left" ? safe : align === "right" ? 1080 - safe - w : 540 - w / 2;
  if (style === "stamp") {
    ctx.save();
    ctx.translate(boxX + w / 2, 460);
    ctx.rotate(-0.12);
    const ink = paint.box || "#f4f1ea";
    if (paint.box) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 8;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    const x = tx(-w / 2 + pad, w / 2 - pad);
    lines.forEach((line, i) => say(line, x, -h / 2 + 18 + lineH / 2 + i * lineH, ink));
    ctx.restore();
    return;
  }
  const y = 960 - h / 2;
  if (paint.box) { ctx.fillStyle = paint.box; ctx.fillRect(boxX, y, w, h); }
  const x = tx(boxX + pad, boxX + w - pad);
  lines.forEach((line, i) => say(line, x, y + 18 + lineH / 2 + i * lineH, paint.text));
}

async function captionPng(text, style) {
  await loadFont();
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");
  drawCaption(ctx, text, style);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw knownError("Could not stitch the reel.");
  return new Uint8Array(await blob.arrayBuffer());
}

function songExt(name) {
  const ext = String(name || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["m4a", "mp3", "wav", "aac", "ogg", "flac", "webm", "mp4"].includes(ext) ? ext : "m4a";
}

function reelFilter(durations, transition, songStart) {
  const count = durations.length;
  const parts = [];
  const tags = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const dur = durations[i].toFixed(3);
    // Frame-aligned cut points at 24 fps, so the shots add up to exactly the reel length.
    const frames = Math.max(1, Math.round((at + durations[i]) * 24) - Math.round(at * 24));
    at += durations[i];
    // Hold the clip's last frame if the render is shorter than its shot, then cut to the exact shot length.
    const head = `[${i}:v]setpts=PTS-STARTPTS,fps=24,tpad=stop_mode=clone:stop_duration=${dur},trim=end_frame=${frames},setpts=PTS-STARTPTS`;
    let chain = `${head},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p`;
    if (transition === "whip" && i > 0) {
      chain = `${head},scale=1620:1920:force_original_aspect_ratio=increase,crop=1080:1920:x='(in_w-1080)*max(0\\,1-t/0.18)':y='(in_h-1920)/2',format=yuv420p`;
    } else if (transition === "flash" && i > 0) {
      chain += `,fade=t=in:st=0:d=0.08:color=white`;
    }
    parts.push(`${chain}[v${i}]`);
    parts.push(`[v${i}][${count + i}:v]overlay=0:0:format=auto,format=yuv420p[c${i}]`);
    tags.push(`[c${i}]`);
  }
  parts.push(`${tags.join("")}concat=n=${count}:v=1:a=0[outv]`);
  const reel = durations.reduce((sum, dur) => sum + dur, 0);
  const fadeAt = Math.max(0, reel - FADE_OUT);
  parts.push(`[${count * 2}:a]atrim=start=${songStart.toFixed(3)}:end=${(songStart + reel).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,apad=whole_dur=${reel.toFixed(3)},atrim=end=${reel.toFixed(3)},afade=t=out:st=${fadeAt.toFixed(3)}:d=${FADE_OUT.toFixed(3)}[a]`);
  return parts.join(";");
}

async function stitchReel(clips, shots, transition, style, songStart, signal) {
  const ffmpeg = await loadFfmpeg();
  if (signal.aborted) throw cancelled();
  const stop = () => {
    ffmpeg.terminate();
    ffmpegPromise = null;
  };
  signal.addEventListener("abort", stop, { once: true });
  const names = [];
  const logs = [];
  const onLog = ({ message }) => {
    logs.push(message);
    if (logs.length > 60) logs.shift();
  };
  ffmpeg.on("log", onLog);
  const durations = shots.map((shot) => shot.end - shot.start);
  const ext = songExt(real.songName);
  try {
    for (let i = 0; i < clips.length; i += 1) {
      const name = `clip${i}.mp4`;
      await ffmpeg.writeFile(name, clips[i].slice());
      names.push(name);
    }
    for (let i = 0; i < shots.length; i += 1) {
      const name = `cap${i}.png`;
      await ffmpeg.writeFile(name, await captionPng(shots[i].caption, style));
      names.push(name);
    }
    const songName = `song.${ext}`;
    await ffmpeg.writeFile(songName, new Uint8Array(real.songBytes));
    names.push(songName);
    let code;
    try {
      code = await ffmpeg.exec([
      "-y",
      ...clips.flatMap((_, i) => ["-i", `clip${i}.mp4`]),
      ...shots.flatMap((_, i) => ["-i", `cap${i}.png`]),
      "-i", songName,
      "-filter_complex", reelFilter(durations, transition, songStart),
      "-map", "[outv]",
      "-map", "[a]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ac", "2",
      "-movflags", "+faststart",
      "-t", durations.reduce((sum, dur) => sum + dur, 0).toFixed(3),
      "reel.mp4",
      ]);
    } catch (err) {
      if (signal.aborted) throw cancelled();
      console.error("ffmpeg exec crashed", err, logs);
      ffmpeg.terminate();
      ffmpegPromise = null;
      throw knownError(`Could not stitch the reel: the stitcher crashed (${(err && err.message) || err}). Press Generate to retry the stitch.`);
    }
    if (code !== 0) {
      console.error("ffmpeg exit", code, logs.join("\n"));
      const tail = logs.filter((line) => /error|invalid|failed|cannot|could not|no such|not found|mismatch/i.test(line)).slice(-2).join(" | ") || logs.slice(-2).join(" | ");
      throw knownError(`Could not stitch the reel (code ${code}): ${tail}`);
    }
    const data = await ffmpeg.readFile("reel.mp4");
    names.push("reel.mp4");
    return data;
  } finally {
    signal.removeEventListener("abort", stop);
    ffmpeg.off("log", onLog);
    for (const name of signal.aborted ? [] : names) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // The file may already be gone.
      }
    }
  }
}

function showReel(bytes) {
  const blob = new Blob([bytes], { type: "video/mp4" });
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  ph.hidden = true;
  video.hidden = false;
  video.src = downloadUrl;
  video.load();
  dl.href = downloadUrl;
  dl.download = "dropcut-reel.mp4";
  dl.hidden = false;
  video.currentTime = 0;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });
}

async function generateReal() {
  if (running) return;
  readRealForm();
  const blocked = paintGate();
  if (blocked) {
    pushLog(blocked);
    return;
  }
  running = true;
  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  song.pause();
  songBtn.textContent = "▶ Play song";
  clearPlayback();
  gen.disabled = true;
  gen.textContent = "Cutting…";
  bar.style.width = "0";
  log.innerHTML = "";
  try {
    if (!(await checkRenderer())) throw knownError("Renderer is offline");
    await ensureSong();
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    real.baseSeed = seedBytes[0] % 2147483646 || 1;
    let fresh = false;
    for (let attempt = 0; attempt < 4 && !fresh; attempt += 1) fresh = await refreshAnalysis();
    const segments = fresh ? (real.analysis?.segments || []) : [];
    const lateBlock = realBlock();
    if (lateBlock) throw knownError(lateBlock);
    if (segments.length !== real.photos.length) throw knownError("Could not build the cut list.");
    const cutTotal = segments[segments.length - 1].end;
    if (Math.abs(cutTotal - real.windowLen) > 0.002) throw knownError("Could not build the cut list.");
    const brief = real.brief;
    const style = real.captionStyle;
    const transition = real.transition;
    const songStart = real.windowStart;
    const shots = real.photos.map((photo, index) => ({
      index,
      file: photo.file,
      type: photo.type,
      look: photo.look,
      caption: photo.caption,
      start: segments[index].start,
      end: segments[index].end,
      seed: segments[index].seed,
    }));
    const pending = real.pendingStitch;
    const reuse = pending && pending.files.length === shots.length && pending.files.every((file, i) => file === shots[i].file);
    let clips;
    if (reuse) {
      clips = pending.clips;
      pushLog("reusing the rendered clips");
    } else {
      real.pendingStitch = null;
      clips = new Array(shots.length);
      let finished = 0;
      await mapPool(shots, 2, async (shot) => {
        clips[shot.index] = await postShot(shot, brief, signal);
        finished += 1;
        bar.style.width = `${Math.round((finished / shots.length) * 80)}%`;
      });
      real.pendingStitch = { files: shots.map((shot) => shot.file), clips };
    }
    pushLog("stitching");
    bar.style.width = "90%";
    const reel = await stitchReel(clips, shots, transition, style, songStart, signal);
    real.pendingStitch = null;
    bar.style.width = "100%";
    pushLog(`done · dropcut-reel.mp4 · ${segments[segments.length - 1].end.toFixed(2)}s`);
    showReel(reel);
    gen.textContent = "Generate again";
  } catch (err) {
    if (signal.aborted || (err && err.cancelled)) {
      pushLog(real.pendingStitch ? "cancelled · rendered clips kept, Generate reuses them" : "cancelled");
      bar.style.width = "0";
      gen.textContent = "Generate";
      return;
    }
    const message = err && err.known ? err.message : "Renderer is offline";
    pushLog(message);
    if (message === "Renderer is offline") {
      note.classList.add("warn");
      note.textContent = message;
    }
    gen.textContent = "Generate";
  } finally {
    running = false;
    abortCtl = null;
    cancelBtn.hidden = true;
    gen.disabled = false;
    paintGate();
  }
}

function generate() {
  if (running) return;
  running = true;
  song.pause();
  songBtn.textContent = "▶ Play song";
  gen.disabled = true;
  gen.textContent = "Cutting…";
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  dl.hidden = true;
  const current = D.presets[preset];
  const steps = [
    ["detecting beats · 124 bpm", 8],
    ["building cut list · 5 segments", 16],
    ...current.segments.map((segment, i) => [`rendering A${i + 1} · ${segment.look} · ${segment.end - segment.start > 3 ? 93 : 46} frames`, 26 + i * 13]),
    ["burning captions · " + (CAPS[current.captionStyle] || current.captionStyle).toLowerCase(), 94],
    ["muxing audio · h.264 · 9:16", 100],
  ];
  video.src = `media/${preset}.mp4`;
  video.preload = "auto";
  video.load();
  log.innerHTML = "";
  let i = 0;
  const next = () => {
    const [msg, pct] = steps[i];
    log.insertAdjacentHTML("beforeend", `<li>&gt; ${esc(msg)}</li>`);
    while (log.children.length > 5) log.firstElementChild.remove();
    bar.style.width = `${pct}%`;
    if (++i < steps.length) {
      timer = setTimeout(next, 380 + Math.random() * 260);
      return;
    }
    timer = setTimeout(done, 350);
  };
  next();
}

function done() {
  running = false;
  cancelBtn.hidden = true;
  log.insertAdjacentHTML("beforeend", `<li>&gt; done · ${preset}.mp4 · ${D.duration.toFixed(2)}s</li>`);
  while (log.children.length > 5) log.firstElementChild.remove();
  ph.hidden = true;
  video.hidden = false;
  dl.href = `media/${preset}.mp4`;
  dl.setAttribute("download", `dropcut-${preset}.mp4`);
  dl.hidden = false;
  gen.disabled = false;
  gen.textContent = "Generate again";
  video.currentTime = 0;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });
}

cancelBtn.addEventListener("click", () => {
  if (!running) return;
  cancelBtn.disabled = true;
  if (abortCtl) {
    pushLog("cancelling…");
    abortCtl.abort();
    return;
  }
  clearTimeout(timer);
  running = false;
  cancelBtn.hidden = true;
  pushLog("cancelled");
  bar.style.width = "0";
  gen.disabled = false;
  gen.textContent = "Generate";
});

gen.addEventListener("click", () => {
  if (mode === "real") generateReal();
  else generate();
});
video.addEventListener("timeupdate", () => highlight(video.currentTime));

const clocks = document.querySelectorAll(".js-time");
const t0 = performance.now();
const tick = (now) => {
  clocks.forEach((clock) => {
    clock.textContent = tc((now - t0) / 1000);
  });
  requestAnimationFrame(tick);
};
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(tick);

addEventListener("resize", drawWave);
if (document.fonts) document.fonts.ready.then(drawWave);
renderSheet();
reset();
