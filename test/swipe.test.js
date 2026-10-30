import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwipeDetector } from '../src/renderer/swipe.js';

// A trackpad gesture as the wheel events give it: the fingers (deltas growing,
// then steady), then the momentum (deltas dying down), one event every 16 ms.
function gesture(dir = 1, { fingers = [3, 8, 15, 22, 25, 24, 20], momentum = 40, start = 0 } = {}) {
  const out = [];
  let t = start;
  for (const d of fingers) out.push([dir * d, t += 16]);
  let d = fingers.at(-1);
  for (let i = 0; i < momentum && d >= 1; i++) out.push([dir * (d = Math.round(d * 0.88 * 10) / 10), t += 16]);
  return out;
}
const run = (events) => {
  const steps = [];
  const sw = new SwipeDetector((dir) => steps.push(dir));
  for (const [dx, t] of events) sw.wheel(dx, 0, t);
  return steps;
};

test('a swipe, with its momentum, is one step', () => {
  assert.deepEqual(run(gesture(1)), [1]);
  assert.deepEqual(run(gesture(-1)), [-1]);
});

test('swipes in a row, each started during the momentum of the one before, are a step each', () => {
  const a = gesture(1, { momentum: 12 }); // cut short: the fingers come back on the trackpad
  const b = gesture(1, { momentum: 12, start: a.at(-1)[1] });
  const c = gesture(1, { start: b.at(-1)[1] });
  assert.deepEqual(run([...a, ...b, ...c]), [1, 1, 1]);
});

test('a swipe the other way during the momentum counts at once', () => {
  const a = gesture(1, { momentum: 8 });
  assert.deepEqual(run([...a, ...gesture(-1, { start: a.at(-1)[1] })]), [1, -1]);
});

test('swipes after a pause are a step each', () => {
  const a = gesture(1);
  assert.deepEqual(run([...a, ...gesture(1, { start: a.at(-1)[1] + 500 })]), [1, 1]);
});

test('a slow drag of the fingers and vertical scrolling take no step', () => {
  assert.deepEqual(run(gesture(1, { fingers: [2, 3, 3, 2, 3, 2], momentum: 3 })), []);
  const sw = new SwipeDetector();
  for (let t = 0; t < 400; t += 16) assert.equal(sw.wheel(20, 40, t), 0);
});
