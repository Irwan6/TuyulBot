// The public market-data contract every venue adapter implements (OKX today, Hyperliquid next).
//
// This lives outside okx/ on purpose: the market layer (market/data.ts, market/universe.ts) must not depend on
// any one exchange. `src/okx/public.ts` re-exports it so existing imports keep working.

import type { Candle, FundingNow, Instrument, Ticker } from "./types.js";

export interface PublicApi {
  instruments(): Promise<Instrument[]>;
  tickers(): Promise<Map<string, Ticker>>;
  candles(instId: string, bar: "15m" | "1H" | "4H", limit: number): Promise<Candle[]>;
  openInterest(): Promise<Map<string, number>>;
  funding(instId: string): Promise<FundingNow>;
  fundingHistory(instId: string, limit: number): Promise<number[]>;
  /**
   * Refresh the order books (and therefore the measured spread) for these coins.
   *
   * Separate from `tickers()` on purpose. A venue with a batch ticker call (OKX) folds bid/ask into it, but
   * Hyperliquid needs one request PER BOOK, and books are the expensive part: quoting 86 coins every tick costs
   * 4x the whole per-minute weight budget. Mark prices come free from the batch snapshot, and only the spread
   * gate needs a real book, so this is called on the slow data-refresh cadence instead of every tick.
   */
  refreshSpreads?(coins: string[]): Promise<void>;
}

/**
 * How many settlements a venue charges per day, and how many funding samples a history call covers.
 *
 * OKX settles 3x/day (00/08/16 UTC) and `fundingHistory(id, 90)` returns 30 days of 3/day samples, so
 * "1 sample = 1 settlement = 8h" and fundingPct is the per-settlement rate.
 *
 * Hyperliquid settles HOURLY: its fundingHistory returns 1 sample/hour, so a z-score over that history is
 * already normalised and needs no rescaling, but a raw rate compared against a threshold must be scaled.
 */
export interface VenueFunding {
  /** Settlements per day (OKX 3, Hyperliquid 24). */
  perDay: number;
  /** Hours between settlements (OKX 8, Hyperliquid 1). */
  intervalHours: number;
}
