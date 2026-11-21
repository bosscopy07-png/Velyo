/**
 * Per-giveaway admission control + FIFO mutex. Pure (no database, no Redis).
 *
 * Problem it solves: 1,000 visitors race for 20 slots. Without it, all 1,000 queue
 * for the same lock, most time out ("busy"), and every request does heavy work.
 * With it:
 *  - `admit()` lets in only as many requests as there are free slots (plus none extra);
 *    everybody else is told "full" INSTANTLY with no database work;
 *  - admitted requests run one at a time in arrival order (`exclusive`), with no polling.
 * The database transaction stays the only AUTHORITY: this gate can only reject early or
 * order work, never approve a slot. A stale hint therefore can't over-issue.
 */
export interface Hint { remaining: number; held: number }

export class ClaimGate {
  held = 0;
  inflight = 0;
  private remaining: number | null = null;
  private at = 0;
  private loading: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly load: () => Promise<Hint>,
    private readonly ttlMs = 2000,
    private readonly now: () => number = Date.now
  ) {}

  /** true = this request may proceed to the authoritative section. */
  async admit(): Promise<boolean> {
    if (this.remaining === null || (this.inflight === 0 && this.now() - this.at > this.ttlMs)) await this.refresh();
    if (this.remaining !== null && this.inflight >= this.remaining) return false;
    this.inflight++;
    return true;
  }

  release(success: boolean): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (success) this.held++; // a new reservation now holds a slot (it may expire and reopen)
    if (success && this.remaining !== null && this.remaining > 0) this.remaining--;
  }

  /** The authoritative check said FULL: stop admitting until the hint is refreshed. */
  markFull(held: number): void {
    this.remaining = 0;
    this.held = held;
    this.at = this.now();
  }

  /** Slots may have been freed (expiry sweep): forget the hint. */
  reset(): void {
    this.remaining = null;
  }

  /** Run `fn` after every previously queued job, one at a time. Never rejects the chain. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private refresh(): Promise<void> {
    this.loading ??= this.load()
      .then((h) => { this.remaining = h.remaining; this.held = h.held; this.at = this.now(); })
      .finally(() => { this.loading = null; });
    return this.loading;
  }
                          }
