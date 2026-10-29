export const MIN_SEG = 0.35;
export const MAX_SEG = 6.5;
export const MAX_WINDOW = 60;
export const MAX_PHOTOS = 10;
export const LENGTHS = [5, 10, 15, 30, 60];

// Photo rules per reel length (approved): 5/10/15 s => exactly 5, 30 s => 5-10, 60 s => exactly 10.
export function photoRange(length) {
  const len = Number(length);
  if (len === 60) return { min: 10, max: 10 };
  if (len === 30) return { min: 5, max: 10 };
  return { min: 5, max: 5 };
}

export function photoRuleError(length, count) {
  const { min, max } = photoRange(length);
  const n = Math.trunc(Number(count)) || 0;
  if (n >= min && n <= max) return null;
  const need = min === max ? `exactly ${min} photos` : `${min} to ${max} photos`;
  return `${length} s needs ${need} · you have ${n}.`;
}
export const DEFAULT_WINDOW = 15;

const MIN_MS = 350;
const MAX_MS = 6500;
const SEED_SPAN = 2147483647;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(n, lo, hi) {
  const value = Math.trunc(Number(n));
  if (!Number.isFinite(value)) return lo;
  return clamp(value, lo, hi);
}

function toMs(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

export function seedFor(baseSeed, index) {
  const base = Number.isFinite(Number(baseSeed)) ? Math.trunc(Number(baseSeed)) : 1;
  const sum = base + Math.trunc(Number(index) || 0);
  return ((sum % SEED_SPAN) + SEED_SPAN) % SEED_SPAN;
}

export function buildCutList({
  beats = [],
  duration = DEFAULT_WINDOW,
  photoCount = 1,
  drop = null,
  baseSeed = 1,
} = {}) {
  const count = clampInt(photoCount, 1, MAX_PHOTOS);
  let windowMs = toMs(duration);
  if (windowMs <= 0) windowMs = DEFAULT_WINDOW * 1000;
  windowMs = clamp(windowMs, MIN_MS, MAX_WINDOW * 1000);

  let reel = Math.min(windowMs, count * MAX_MS);
  if (reel < count * MIN_MS) reel = count * MIN_MS;

  const ideal = reel / count;
  const beatMs = [...new Set((Array.isArray(beats) ? beats : []).map(toMs).filter((t) => t > 0 && t < reel))].sort((a, b) => a - b);

  const dropMs = Number.isFinite(Number(drop)) ? toMs(drop) : null;
  let dropCut = 0;
  if (dropMs != null && count > 1) {
    dropCut = clampInt(Math.round(dropMs / ideal), 1, count - 1);
  }

  const points = [0];
  for (let k = 1; k < count; k += 1) {
    const prev = points[k - 1];
    const remain = count - k;
    let lo = Math.max(prev + MIN_MS, reel - remain * MAX_MS);
    let hi = Math.min(prev + MAX_MS, reel - remain * MIN_MS);
    if (hi < lo) hi = lo;
    let target = clamp(Math.round(k * ideal), lo, hi);
    if (k === dropCut && dropMs != null && dropMs >= lo && dropMs <= hi) {
      target = dropMs;
    } else {
      let best = null;
      let bestDist = Infinity;
      for (const beat of beatMs) {
        if (beat < lo || beat > hi) continue;
        const dist = Math.abs(beat - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = beat;
        }
      }
      if (best != null) target = best;
    }
    points.push(target);
  }
  points.push(reel);

  for (let i = 1; i < points.length; i += 1) {
    if (points[i] < points[i - 1] + MIN_MS) points[i] = points[i - 1] + MIN_MS;
    else if (points[i] > points[i - 1] + MAX_MS) points[i] = points[i - 1] + MAX_MS;
  }

  let dropIndex = -1;
  if (dropMs != null) {
    let bestDist = Infinity;
    for (let i = 0; i < count; i += 1) {
      const dist = Math.abs(points[i] - dropMs);
      if (dist < bestDist) {
        bestDist = dist;
        dropIndex = i;
      }
    }
    if (bestDist > 200) dropIndex = -1;
  }

  const segments = [];
  for (let i = 0; i < count; i += 1) {
    segments.push({
      start: points[i] / 1000,
      end: points[i + 1] / 1000,
      seed: seedFor(baseSeed, i),
      cue: i === dropIndex ? "DROP" : "HOLD",
    });
  }
  return { duration: points[count] / 1000, segments };
}

function estimateBpm(peaks) {
  if (!peaks || peaks.length < 2) return 120;
  const hist = new Map();
  for (let i = 1; i < peaks.length; i += 1) {
    const dt = peaks[i] - peaks[i - 1];
    if (dt < 0.3 || dt > 1.2) continue;
    const bpm = Math.round(60 / dt);
    if (bpm < 70 || bpm > 180) continue;
    hist.set(bpm, (hist.get(bpm) || 0) + 1);
  }
  let best = 120;
  let count = 0;
  for (const [bpm, hits] of hist) {
    if (hits > count) {
      count = hits;
      best = bpm;
    }
  }
  return best;
}

function beatGrid(bpm, duration, peaks) {
  const step = 60 / bpm;
  let phase = 0;
  let bestScore = -1;
  const candidates = peaks && peaks.length ? peaks.map((p) => ((p % step) + step) % step) : [0];
  const seen = new Set();
  for (const candidate of candidates) {
    const rounded = Math.round(candidate * 100) / 100;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    let score = 0;
    for (const peak of peaks || []) {
      const k = Math.round((peak - rounded) / step);
      if (Math.abs(rounded + k * step - peak) < 0.08) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      phase = rounded;
    }
  }
  const beats = [];
  for (let t = phase; t < duration - 0.02; t += step) {
    if (t > 0.02) beats.push(Math.round(t * 1000) / 1000);
  }
  return beats;
}

export function analyzeWindow(channel, sampleRate) {
  const sr = sampleRate > 0 ? sampleRate : 44100;
  const hop = 512;
  const length = channel?.length || 0;
  const duration = length / sr;
  const energies = [];
  for (let i = 0; i + hop <= length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j += 1) {
      const sample = channel[i + j];
      sum += sample * sample;
    }
    energies.push(Math.sqrt(sum / hop));
  }
  if (!energies.length) {
    return { bpm: 120, beats: [], drop: 0, peaks: [], duration };
  }
  const onsets = new Array(energies.length);
  let prev = energies[0];
  for (let i = 0; i < energies.length; i += 1) {
    const energy = energies[i];
    onsets[i] = Math.max(0, energy - prev);
    prev = energy;
  }
  let mean = 0;
  for (const onset of onsets) mean += onset;
  mean /= onsets.length;
  let variance = 0;
  for (const onset of onsets) {
    const delta = onset - mean;
    variance += delta * delta;
  }
  const threshold = mean + Math.sqrt(variance / onsets.length) * 0.9;
  const hopSec = hop / sr;
  const onsetsAt = [];
  let last = -1;
  for (let i = 1; i < onsets.length - 1; i += 1) {
    if (onsets[i] < threshold || onsets[i] < onsets[i - 1] || onsets[i] < onsets[i + 1]) continue;
    const t = i * hopSec;
    if (t - last < 0.28) continue;
    onsetsAt.push(t);
    last = t;
  }
  const bpm = estimateBpm(onsetsAt);
  const beats = beatGrid(bpm, duration, onsetsAt);
  let drop = 0;
  let best = -1;
  const win = Math.max(1, Math.round(0.35 / hopSec));
  for (let i = 0; i < energies.length; i += 1) {
    let sum = 0;
    const end = Math.min(energies.length, i + win);
    for (let j = i; j < end; j += 1) sum += energies[j];
    if (sum > best) {
      best = sum;
      drop = i * hopSec;
    }
  }
  const columns = 160;
  const draw = new Array(columns).fill(0);
  const step = energies.length / columns;
  let maxEnergy = 0.0001;
  for (let c = 0; c < columns; c += 1) {
    const start = Math.floor(c * step);
    const end = Math.max(start + 1, Math.floor((c + 1) * step));
    let peak = 0;
    for (let i = start; i < end && i < energies.length; i += 1) peak = Math.max(peak, energies[i]);
    draw[c] = peak;
    if (peak > maxEnergy) maxEnergy = peak;
  }
  return {
    bpm,
    beats,
    drop,
    peaks: draw.map((value) => value / maxEnergy),
    duration,
  };
}
