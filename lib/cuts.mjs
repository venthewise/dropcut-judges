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

// Tempo detection.
// 1) Onset strength: spectral flux over 24 log-spaced bands (about 10 ms hop) on a
//    level-normalised signal, with the slow trend removed. A low-band copy (<200 Hz) is kept too.
// 2) Coarse tempo: autocorrelation of that envelope (beat, half and double lag), weighted by a
//    soft prior centred on 120 BPM.
// 3) Ratio check: the winner is compared with its 2x, 1/2, 3/2, 2/3, 4/3 and 3/4 relatives by how
//    well a beat grid lines up with the onsets, so a 124 BPM song is not read as 165 (4/3).
// 4) Phase and fine tempo: pick the grid offset (kicks/bass weigh extra, and a real beat has
//    onsets halfway between beats too), then fit a line through the onsets nearest each beat.
export const MIN_BPM = 70;
export const MAX_BPM = 180;
const PRIOR_BPM = 120;
const MIN_FLUX = 0.01;
const PRIOR_OCTAVES = 1;
const RATIOS = [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75];

const twiddles = new Map();
function twiddleFor(n) {
  let t = twiddles.get(n);
  if (!t) {
    t = { cos: new Float64Array(n >> 1), sin: new Float64Array(n >> 1) };
    for (let k = 0; k < n >> 1; k += 1) {
      t.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      t.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddles.set(n, t);
  }
  return t;
}

function fftInPlace(re, im) {
  const n = re.length;
  const { cos, sin } = twiddleFor(n);
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export function onsetEnvelope(channel, sampleRate) {
  const sr = sampleRate > 0 ? sampleRate : 44100;
  const length = channel?.length || 0;
  const hop = Math.max(16, Math.round(sr / 100));
  let size = 1;
  while (size < hop * 2) size <<= 1;
  const frames = length >= size ? Math.floor((length - size) / hop) + 1 : 0;
  const env = new Float64Array(frames);
  if (!frames) return { env, low: new Float64Array(0), frameRate: sr / hop, offset: size / 2 / sr };
  const lowEnv = new Float64Array(frames);
  // Work on a level-normalised signal so quiet and loud masters read the same.
  let level = 0;
  for (let i = 0; i < length; i += 1) {
    const a = Math.abs(channel[i]);
    if (a > level) level = a;
  }
  const gain = level > 0 ? 1 / level : 0;
  const bins = size >> 1;
  // Log-spaced bands (40 Hz to 8 kHz) so a kick counts as much as a hi-hat.
  const edges = [];
  const lowest = 40;
  const highest = Math.min(8000, sr / 2);
  const bandCount = 24;
  for (let b = 0; b <= bandCount; b += 1) {
    const hz = lowest * Math.pow(highest / lowest, b / bandCount);
    const bin = Math.min(bins, Math.max(1, Math.round((hz * size) / sr)));
    if (!edges.length || bin > edges[edges.length - 1]) edges.push(bin);
  }
  const bands = edges.length - 1;
  let lowBands = 0;
  while (lowBands < bands && (edges[lowBands + 1] * sr) / size <= 200) lowBands += 1;
  lowBands = Math.max(1, lowBands);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let prev = new Float64Array(bands);
  let cur = new Float64Array(bands);
  for (let f = 0; f < frames; f += 1) {
    const at = f * hop;
    for (let i = 0; i < size; i += 1) {
      re[i] = (channel[at + i] || 0) * gain * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let b = 0; b < bands; b += 1) {
      let mag = 0;
      for (let k = edges[b]; k < edges[b + 1]; k += 1) mag += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      cur[b] = Math.log1p((100 * mag) / (edges[b + 1] - edges[b]));
      if (f > 0) {
        const d = cur[b] - prev[b];
        if (d > 0) {
          flux += d;
          if (b < lowBands) lowFlux += d;
        }
      }
    }
    env[f] = flux;
    lowEnv[f] = lowFlux;
    const t = prev; prev = cur; cur = t;
  }
  const rate = sr / hop;
  return { env: detrend(env, rate), low: detrend(lowEnv, rate), frameRate: rate, offset: size / 2 / sr };
}

// Remove the slow trend (about 0.5 s) so loud passages do not swamp the beat, then scale to 0..1.
function detrend(env, frameRate) {
  const frames = env.length;
  const half = Math.max(1, Math.round(frameRate * 0.25));
  const out = new Float64Array(frames);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < frames; i += 1) {
    while (hi < Math.min(frames - 1, i + half)) sum += env[++hi];
    while (lo < i - half) sum -= env[lo++];
    out[i] = Math.max(0, env[i] - sum / (hi - lo + 1));
  }
  let peak = 0;
  for (const v of out) if (v > peak) peak = v;
  // Steady tones and silence only leave rounding noise; treat that as "no onsets".
  if (peak < MIN_FLUX) return out.fill(0);
  for (let i = 0; i < frames; i += 1) out[i] /= peak;
  return out;
}

function tempoPrior(bpm) {
  const o = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES;
  return Math.exp(-0.5 * o * o);
}

function autocorrelation(env, maxLag) {
  const n = env.length;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n || 1;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag += 1) {
    let s = 0;
    for (let i = lag; i < n; i += 1) s += (env[i] - mean) * (env[i - lag] - mean);
    ac[lag] = s / (n - lag);
  }
  const zero = ac[0] || 1;
  for (let i = 0; i <= maxLag; i += 1) ac[i] /= zero;
  return ac;
}

function acAt(ac, lag) {
  if (lag < 1 || lag >= ac.length - 1) return 0;
  const i = Math.floor(lag);
  const f = lag - i;
  return ac[i] * (1 - f) + ac[i + 1] * f;
}

// How well a beat grid at this period lines up with onsets (best phase), above the envelope mean.
function combScore(env, period, mean) {
  const n = env.length;
  if (period < 2 || n < period * 2) return { score: 0, phase: 0 };
  let best = -Infinity;
  let bestPhase = 0;
  const phases = Math.ceil(period);
  for (let ph = 0; ph < phases; ph += 1) {
    let s = 0;
    let count = 0;
    for (let pos = ph; pos < n; pos += period) {
      const i = Math.round(pos);
      if (i >= n) break;
      s += Math.max(env[i], i > 0 ? env[i - 1] : 0, i + 1 < n ? env[i + 1] : 0);
      count += 1;
    }
    const v = count ? s / count : 0;
    if (v > best) {
      best = v;
      bestPhase = ph;
    }
  }
  return { score: best - mean, phase: bestPhase };
}

function combAt(env, period, phase) {
  const n = env.length;
  let s = 0;
  let count = 0;
  for (let pos = phase; pos < n; pos += period) {
    const i = Math.round(pos);
    if (i >= n) break;
    s += Math.max(env[i], i > 0 ? env[i - 1] : 0, i + 1 < n ? env[i + 1] : 0);
    count += 1;
  }
  return count ? s / count : 0;
}

function pickPhase(pulse, period) {
  let best = -Infinity;
  let phase = 0;
  for (let ph = 0; ph < Math.ceil(period); ph += 1) {
    const s = combAt(pulse, period, ph) + 0.5 * combAt(pulse, period, ph + period / 2);
    if (s > best) {
      best = s;
      phase = ph;
    }
  }
  return phase;
}

function metricScore(env, period, mean) {
  // A real beat level usually has a consistent half-beat level too.
  const beat = combScore(env, period, mean);
  const sub = combScore(env, period / 2, mean).score;
  return { score: beat.score + 0.25 * Math.max(0, sub), phase: beat.phase };
}

export function estimateTempo(env, frameRate, low = null) {
  const n = env.length;
  if (n < frameRate * 1.5) return null;
  const maxLag = Math.min(n - 1, Math.ceil((frameRate * 60 * 2) / MIN_BPM) + 2);
  const ac = autocorrelation(env, maxLag);
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let coarse = 0;
  let coarseScore = -Infinity;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) {
    const lag = (frameRate * 60) / bpm;
    const s = (acAt(ac, lag) + 0.5 * acAt(ac, lag * 2) + 0.5 * acAt(ac, lag / 2)) * tempoPrior(bpm);
    if (s > coarseScore) {
      coarseScore = s;
      coarse = bpm;
    }
  }
  if (!(coarseScore > 0)) return null;
  // Refine one candidate: best exact BPM near it by comb alignment over the whole window.
  const refine = (center) => {
    let best = { bpm: center, score: -Infinity, phase: 0 };
    const span = center * 0.02;
    for (let bpm = center - span; bpm <= center + span + 1e-9; bpm += 0.05) {
      if (bpm < MIN_BPM - 1e-9 || bpm > MAX_BPM + 1e-9) continue;
      const m = metricScore(env, (frameRate * 60) / bpm, mean);
      if (m.score > best.score) best = { bpm, score: m.score, phase: m.phase };
    }
    return best;
  };
  let winner = null;
  for (const ratio of RATIOS) {
    const bpm = coarse * ratio;
    if (bpm < MIN_BPM - 1 || bpm > MAX_BPM + 1) continue;
    const r = refine(clamp(bpm, MIN_BPM, MAX_BPM));
    const weighted = r.score * tempoPrior(r.bpm);
    if (!winner || weighted > winner.weighted) winner = { ...r, weighted };
  }
  if (!winner || !(winner.score > 0)) return null;
  // Phase: beat vs off-beat (or a syncopated 16th) is the classic trap. Kicks and bass
  // get extra say, and a true beat should also have onsets halfway between beats.
  const pulse = new Float64Array(n);
  for (let i = 0; i < n; i += 1) pulse[i] = env[i] + (low && low.length === n ? low[i] : 0);
  winner.phase = pickPhase(pulse, (frameRate * 60) / winner.bpm);
  // Sub-frame fit: snap each predicted beat to the onset centroid near it, then fit a straight line.
  let period = (frameRate * 60) / winner.bpm;
  let phaseFrames = winner.phase;
  for (let pass = 0; pass < 2; pass += 1) {
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    const reach = Math.max(1, Math.round(period * 0.12));
    for (let k = 0, pos = phaseFrames; pos < n; k += 1, pos = phaseFrames + k * period) {
      const c = Math.round(pos);
      let w = 0;
      let at = 0;
      for (let d = -reach; d <= reach; d += 1) {
        const i = c + d;
        if (i < 0 || i >= n) continue;
        w += pulse[i];
        at += pulse[i] * i;
      }
      if (w <= 0) continue;
      const t = at / w;
      sw += w; sk += w * k; st += w * t; skk += w * k * k; skt += w * k * t;
    }
    const den = sw * skk - sk * sk;
    if (!(sw > 0) || Math.abs(den) < 1e-9) break;
    const slope = (sw * skt - sk * st) / den;
    if (!(Math.abs(slope / period - 1) < 0.01)) break;
    period = slope;
    phaseFrames = (st - slope * sk) / sw;
  }
  return { bpm: (frameRate * 60) / period, period, phaseFrames };
}

function beatGrid(bpm, duration, phase) {
  const step = 60 / bpm;
  let start = ((phase % step) + step) % step;
  const beats = [];
  for (let i = 0, t = start; t < duration - 0.02; i += 1, t = start + i * step) {
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
  const hopSec = hop / sr;
  const { env, low, frameRate, offset } = onsetEnvelope(channel, sr);
  const tempo = estimateTempo(env, frameRate, low);
  const bpm = tempo ? Math.round(tempo.bpm * 10) / 10 : 120;
  const beats = tempo ? beatGrid(tempo.bpm, duration, tempo.phaseFrames / frameRate + offset) : [];
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
