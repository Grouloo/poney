// Who may generate now. Every call to a local model passes here, one call at a
// time rather than one task (a parent never holds a turn while its sub-agents wait).
// First come, first served, except that a call for a model already loaded goes
// first (two conversations on two models would reload at each call), past an
// older one at most MAX_PASSES times.
export const MAX_PASSES = 3;

export class InferenceGate {
  /**
   * limit: calls at the same time, 0 for no limit.
   * host.canStart(req): whether it can start now (memory, free slots).
   * host.isLoaded(req): whether its model is ready.
   * host.start(req): it is starting (called before the lease is given).
   */
  constructor(host, limit = 1) {
    this.host = host;
    this.limit = limit;
    this.running = 0;
    this.waiting = [];
  }

  setLimit(limit) {
    this.limit = limit;
    this.pump();
  }

  /** Resolves with a release function when the call may start; rejects if signal aborts first. */
  acquire(req, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const entry = { req, resolve, reject, passes: 0, signal };
      entry.onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(signal.reason ?? new Error('aborted'));
        this.pump();
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  next() {
    const oldest = this.waiting[0];
    if (oldest.passes >= MAX_PASSES) return this.host.canStart(oldest.req) ? oldest : null; // (its turn: the others wait, so that memory frees up)
    return this.waiting.find((e) => this.host.isLoaded(e.req) && this.host.canStart(e.req))
      ?? this.waiting.find((e) => this.host.canStart(e.req)) ?? null;
  }

  pump() {
    while (this.waiting.length && (!this.limit || this.running < this.limit)) {
      const entry = this.next();
      if (!entry) return;
      for (const e of this.waiting) {
        if (e === entry) break;
        e.passes++;
      }
      this.waiting.splice(this.waiting.indexOf(entry), 1);
      entry.signal?.removeEventListener('abort', entry.onAbort);
      this.running++;
      this.host.start(entry.req);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        this.pump();
      });
    }
  }
}
