// Two-finger horizontal swipes, from the wheel events of a trackpad: one step
// per swipe. The browser does not say when the fingers lift, and the momentum
// that follows keeps sending events for a second or so; a new swipe often
// starts during it. So, once a swipe has counted: the events are ignored while
// they die down, and a new swipe is one that grows again (or goes the other way).

const TRIGGER = 50; // horizontal distance (px) for a swipe to count
const QUIET_MS = 150; // no event for this long: the gesture is over

export class SwipeDetector {
  constructor(onSwipe) {
    this.onSwipe = onSwipe; // (dir) => …, dir 1: to the left (next), -1: to the right
    this.reset();
  }

  reset() {
    this.sum = 0;
    this.done = false; // this gesture has counted already
    this.dir = 0;
    this.peak = 0; // since the swipe counted: the largest event…
    this.low = Infinity; // …and the smallest once it died down
    this.last = -Infinity;
  }

  /** One wheel event (deltaX, deltaY, timeStamp in ms). Returns the step taken, or 0. */
  wheel(dx, dy, t) {
    if (Math.abs(dx) <= Math.abs(dy)) return 0;
    if (t - this.last > QUIET_MS) this.reset();
    this.last = t;
    const a = Math.abs(dx);
    if (this.done) {
      const reversed = Math.sign(dx) === -this.dir && a > 2;
      this.peak = Math.max(this.peak, a);
      const dying = this.low < this.peak * 0.5;
      if (dying) this.low = Math.min(this.low, a);
      else if (a < this.peak * 0.5) this.low = a;
      const rising = dying && a > Math.max(4, this.low * 2);
      if (!reversed && !rising) return 0;
      this.reset();
      this.last = t;
    }
    this.sum += dx;
    if (Math.abs(this.sum) < TRIGGER) return 0;
    this.done = true;
    this.dir = Math.sign(this.sum);
    this.peak = a;
    this.onSwipe?.(this.dir);
    return this.dir;
  }
}
