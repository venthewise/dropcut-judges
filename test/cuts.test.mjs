import test from "node:test";
import assert from "node:assert/strict";
import { buildCutList, photoRuleError, photoRange, MAX_SEG, MIN_SEG, MAX_WINDOW, LENGTHS } from "../lib/cuts.mjs";

const beatsFor = (len, bpm = 124) => { const out = []; for (let t = 60 / bpm; t < len; t += 60 / bpm) out.push(+t.toFixed(3)); return out; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function check(len, count, ideal, withBeats) {
  const cuts = buildCutList({ beats: withBeats ? beatsFor(len) : [], duration: len, photoCount: count, drop: withBeats ? len / 2 : null, baseSeed: 7 });
  assert.equal(cuts.segments.length, count);
  assert.ok(near(cuts.duration, len), `reel ${cuts.duration} != ${len}`);
  assert.equal(cuts.segments[0].start, 0);
  for (let i = 0; i < count; i += 1) {
    const seg = cuts.segments[i];
    const d = seg.end - seg.start;
    assert.ok(d >= MIN_SEG - 1e-9 && d <= MAX_SEG + 1e-9, `shot ${i} is ${d}s`);
    if (i > 0) assert.ok(near(seg.start, cuts.segments[i - 1].end));
    if (!withBeats) assert.ok(near(d, ideal, 0.001), `shot ${i} ${d} != ${ideal}`);
  }
  return cuts;
}

test("limits allow 60 s and 6 s shots", () => {
  assert.equal(MAX_WINDOW, 60);
  assert.ok(MAX_SEG >= 6);
  assert.equal(MIN_SEG, 0.35);
  assert.deepEqual(LENGTHS, [5, 10, 15, 30, 60]);
});
test("5 s with 5 photos = 5 x 1 s", () => { check(5, 5, 1, false); check(5, 5, 1, true); });
test("15 s with 5 photos = 5 x 3 s", () => { check(15, 5, 3, false); check(15, 5, 3, true); });
test("60 s with 10 photos = 10 x 6 s", () => { check(60, 10, 6, false); check(60, 10, 6, true); });
test("30 s with 5 photos = 5 x 6 s", () => { check(30, 5, 6, false); check(30, 5, 6, true); });
test("30 s with 10 photos = 10 x 3 s", () => { check(30, 10, 3, false); check(30, 10, 3, true); });
test("10 s with 5 photos = 5 x 2 s", () => { check(10, 5, 2, false); check(10, 5, 2, true); });
test("photo count is capped at 10", () => {
  assert.equal(buildCutList({ duration: 60, photoCount: 14 }).segments.length, 10);
});
test("photo rules per length", () => {
  for (const len of [5, 10, 15]) {
    assert.deepEqual(photoRange(len), { min: 5, max: 5 });
    assert.equal(photoRuleError(len, 5), null);
    assert.equal(photoRuleError(len, 4), `${len} s needs exactly 5 photos · you have 4.`);
    assert.ok(photoRuleError(len, 6));
  }
  for (let n = 5; n <= 10; n += 1) assert.equal(photoRuleError(30, n), null);
  assert.equal(photoRuleError(30, 4), "30 s needs 5 to 10 photos · you have 4.");
  assert.equal(photoRuleError(60, 10), null);
  assert.equal(photoRuleError(60, 7), "60 s needs exactly 10 photos · you have 7.");
});
test("seeds differ per shot", () => {
  const { segments } = buildCutList({ duration: 60, photoCount: 10, baseSeed: 5 });
  assert.equal(new Set(segments.map((s) => s.seed)).size, 10);
});
