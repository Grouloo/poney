import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration } from '../src/renderer/format.js';

test('durations are human-friendly', () => {
  const nbsp = (s) => s.replace(/ | /g, ' ');
  assert.equal(nbsp(fmtDuration(0)), '0,0 s');
  assert.equal(nbsp(fmtDuration(3249)), '3,2 s');
  assert.equal(nbsp(fmtDuration(9999)), '9,9 s');
  assert.equal(fmtDuration(10_000), '10 s');
  assert.equal(fmtDuration(42_700), '42 s');
  assert.equal(fmtDuration(60_000), '1 min 00 s');
  assert.equal(fmtDuration(125_000), '2 min 05 s');
  assert.equal(fmtDuration(3_600_000), '1 h 00 min 00 s');
  assert.equal(fmtDuration(3_792_000), '1 h 03 min 12 s');
  assert.equal(fmtDuration(27 * 3_600_000 + 61_000), '27 h 01 min 01 s');
  assert.equal(nbsp(fmtDuration(-5)), '0,0 s');
});
