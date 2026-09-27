// Weight-based rate limiter for Hyperliquid's /info API.
//
// Hyperliquid's REST limit is an aggregated WEIGHT budget of 1200 per minute per IP, not a request count, and the
// weight of a call depends on what it returns (docs: rate-limits-and-user-limits):
//
//   l2Book, allMids, clearinghouseState, orderStatus, ...   weight 2
//   every other documented info request                     weight 20
//   candleSnapshot                                          weight 20 + 1 per 60 bars returned
//   fundingHistory, userFills, recentTrades, ...            weight 20 + 1 per 20 items returned
//
// So 85 coins x (100x15m + 200x1h candles) is ~4100 weight in one refresh: 3.4x the whole per-minute budget,
// which is what produced a wall of HTTP 429s on the first run. This limiter spends the budget deliberately and
// waits instead of hammering.
//
// A sliding 60 s window is used rather than a token bucket: the upstream limit is a window, and a bucket would
// let a burst through just as the window closes.

export interface WeightCost {
  /** Base weight of the endpoint (20 for most info calls, 2 for l2Book). */
  base: number;
  /** Extra weight for the payload size, if the endpoint charges by items returned. */
  extra?: number;
}

/** Measured weights, so callers do not hand-count. */
export const HL_WEIGHT = {
  /** metaAndAssetCtxs: one call covering instruments, tickers, volume, funding and OI for every coin. */
  metaAndAssetCtxs: { base: 20 },
  /** l2Book is one of the cheap endpoints. */
  l2Book: { base: 2 },
  /** candleSnapshot charges 1 extra per 60 bars returned. */
  candles: (bars: number): WeightCost => ({ base: 20, extra: Math.ceil(bars / 60) }),
  /** fundingHistory charges 1 extra per 20 items returned. */
  fundingHistory: (items: number): WeightCost => ({ base: 20, extra: Math.ceil(items / 20) }),
} as const;

export interface WeightLimiterOpts {
  /** Upstream budget per window (Hyperliquid: 1200). */
  budgetPerMinute?: number;
  /** Fraction of the budget this limiter may use, leaving headroom for other callers on the same IP. */
  safety?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class WeightLimiter {
  private readonly budget: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** [timestamp, weight] of requests inside the window, oldest first. */
  private spent: Array<[number, number]> = [];
  /** Serialises the wait decision so concurrent callers cannot all see the same free budget. */
  private chain: Promise<void> = Promise.resolve();
  /** Total weight spent, for logging. */
  totalSpent = 0;
  /** How many times a caller had to wait. */
  waits = 0;

  constructor(o: WeightLimiterOpts = {}) {
    const budget = o.budgetPerMinute ?? 1200;
    const safety = o.safety ?? 0.75;
    this.budget = Math.max(1, Math.floor(budget * safety));
    this.windowMs = o.windowMs ?? 60_000;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Weight still available in the current window. */
  private free(now: number): number {
    this.spent = this.spent.filter(([t]) => now - t < this.windowMs);
    return this.budget - this.spent.reduce((a, [, w]) => a + w, 0);
  }

  /**
   * Wait until `cost` fits in the window, then record it. A cost larger than the whole budget is clamped: the
   * call still goes out (the caller asked for it) rather than deadlocking forever.
   */
  async consume(cost: WeightCost): Promise<void> {
    const weight = Math.min(this.budget, Math.max(1, cost.base + (cost.extra ?? 0)));
    const run = async () => {
      for (;;) {
        const now = this.now();
        if (this.free(now) >= weight) {
          this.spent.push([now, weight]);
          this.totalSpent += weight;
          return;
        }
        this.waits++;
        // The oldest entry leaves the window at spent[0].t + windowMs; wait until then (at least 25 ms).
        const oldest = this.spent[0];
        const waitMs = oldest ? Math.max(25, oldest[0] + this.windowMs - now + 5) : 25;
        await this.sleep(Math.min(waitMs, this.windowMs));
      }
    };
    // Chain so two concurrent callers cannot both claim the same free budget.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }
}
