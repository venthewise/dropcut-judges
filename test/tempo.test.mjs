import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeWindow } from "../lib/cuts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Synthetic track: "click" = one tick per beat; "drums" = kick on every beat, snare on 2 and 4,
// hi-hats on every 8th; "sync" adds a syncopated kick on the last 16th of beat 3.
function synth({ bpm, sr = 44100, len = 15, start = 0.1, pattern = "click", gain = 1 }) {
  const out = new Float32Array(Math.floor(sr * len));
  const next = rng(7);
  const p = 60 / bpm;
  const hit = (t, amp, freq, decay, noise) => {
    const i0 = Math.round(t * sr);
    for (let i = 0; i < sr * 0.15 && i0 + i < out.length; i += 1) {
      const tt = i / sr;
      out[i0 + i] += gain * amp * Math.exp(-tt / decay) * ((1 - noise) * Math.sin(2 * Math.PI * freq * tt) + noise * (next() * 2 - 1));
    }
  };
  for (let k = 0, t = start; t < len; k += 1, t = start + k * p) {
    if (pattern === "click") {
      hit(t, 0.8, 1000, 0.01, 0.3);
      continue;
    }
    hit(t, 0.9, 60, 0.08, 0.05);
    if (k % 2 === 1) hit(t, 0.5, 200, 0.05, 0.8);
    hit(t, 0.2, 8000, 0.02, 1);
    hit(t + p / 2, 0.25, 8000, 0.02, 1);
    if (pattern === "sync" && k % 4 === 2) hit(t + p * 0.75, 0.6, 60, 0.08, 0.05);
  }
  return out;
}

// Share of detected beats within `tol` seconds of the true grid (start + k * period).
function onGrid(beats, start, bpm, tol = 0.025) {
  const p = 60 / bpm;
  if (!beats.length) return 0;
  let hits = 0;
  for (const b of beats) {
    const k = Math.round((b - start) / p);
    if (Math.abs(b - (start + k * p)) <= tol) hits += 1;
  }
  return hits / beats.length;
}

for (const pattern of ["click", "drums", "sync"]) {
  for (const bpm of [90, 124, 128, 150]) {
    test(`synthetic ${pattern} track at ${bpm} BPM reads ${bpm} and lands on the beat`, () => {
      for (const len of [5, 15, 60]) {
        const sr = 44100;
        const heard = analyzeWindow(synth({ bpm, sr, len, pattern }), sr);
        assert.ok(Math.abs(heard.bpm - bpm) <= 0.5, `${len}s window read ${heard.bpm}`);
        const expected = Math.floor((len - 0.1) / (60 / bpm));
        assert.ok(heard.beats.length >= expected - 1, `${len}s window has ${heard.beats.length} beats`);
        assert.equal(onGrid(heard.beats, 0.1, bpm), 1, `${len}s window beats drift off the clicks`);
      }
    });
  }
}

test("tempo and phase do not depend on playback level", () => {
  const loud = analyzeWindow(synth({ bpm: 124, pattern: "drums" }), 44100);
  const quiet = analyzeWindow(synth({ bpm: 124, pattern: "drums", gain: 0.001 }), 44100);
  assert.equal(quiet.bpm, loud.bpm);
  assert.deepEqual(quiet.beats, loud.beats);
});

test("silence and tiny windows return no beat grid instead of a made-up one", () => {
  for (const samples of [new Float32Array(0), new Float32Array(44100 * 10), new Float32Array(44100 * 0.35)]) {
    const heard = analyzeWindow(samples, 44100);
    assert.equal(heard.bpm, 120);
    assert.deepEqual(heard.beats, []);
  }
});

// Bundled songs. Ground truth (checked independently with librosa onset strength + comb analysis
// and low-band kick onsets): all three are 124 BPM, kick on the beat at 0.0105 s + k * 60/124 s.
// Song lengths agree: 15.484 s = 32 beats and 61.935 s = 128 beats at 124 BPM.
const SONG_BPM = 124;
const SONG_BEAT0 = 0.0105;
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function decode(file, sr = 48000) {
  const res = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], {
    maxBuffer: 1 << 28,
  });
  assert.equal(res.status, 0, String(res.stderr));
  const buf = res.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

for (const name of ["song-15s.m4a", "song-30s.m4a", "song-60s.m4a", "song.m4a"]) {
  test(`sample ${name} reads ${SONG_BPM} BPM with beats on the kick`, { skip: ffmpeg ? false : "ffmpeg not installed" }, () => {
    const sr = 48000;
    const mono = decode(path.join(root, "media", name), sr);
    const songLen = mono.length / sr;
    const windows = [];
    for (const len of [5, 10, 15, 30, 60]) if (len <= songLen + 0.01) windows.push([0, len]);
    for (const start of [3.3, 7, 12.25]) if (start + 5 <= songLen) windows.push([start, Math.min(15, songLen - start)]);
    for (const [start, len] of windows) {
      const heard = analyzeWindow(mono.subarray(Math.floor(start * sr), Math.floor((start + len) * sr)), sr);
      assert.ok(Math.abs(heard.bpm - SONG_BPM) <= 0.5, `${name} ${start}+${len}s read ${heard.bpm} BPM`);
      const absolute = heard.beats.map((b) => b + start);
      assert.ok(onGrid(absolute, SONG_BEAT0, SONG_BPM, 0.03) >= 0.95, `${name} ${start}+${len}s beats are off the kick`);
    }
  });
}
