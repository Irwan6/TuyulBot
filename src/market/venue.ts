// Venue selection: one place that decides which exchange the market feed reads and how the feed must be shaped.
//
// `src/index.ts` and every tool use this instead of constructing an adapter directly, so VENUE=hyperliquid changes
// one thing rather than five call sites.

import { createHyperliquidPublicApi, hlVenueFilter, HL_FUNDING } from "../hyperliquid/public.js";
import { createPublicApi as createOkxPublicApi, OKX_FUNDING } from "../okx/public.js";
import type { PublicApi } from "./public-api.js";

export type VenueId = "okx" | "hyperliquid";

export interface VenueOpts {
  venue: VenueId;
  /** OKX public REST base. */
  okxApiBase: string;
  /** Hyperliquid mainnet / testnet public REST bases. */
  hlMainnetApiBase: string;
  hlTestnetApiBase: string;
  /** MODE=demo reads the demo/testnet market so the feed matches the account being traded. */
  demo?: boolean;
  timeoutMs?: number;
  /** Hyperliquid /info weight budget per minute (documented limit 1200). */
  weightBudgetPerMin?: number;
}

/** Everything the market layer needs to know about the chosen venue, so callers do not branch on the venue id. */
export interface VenueFeed {
  api: PublicApi;
  /** Which instIds may trade on this venue. */
  venueFilter: (instId: string) => boolean;
  /** Settlements per day, for the funding normaliser in MarketFeed. */
  fundingPerDay: number;
  /** Human-readable venue name for logs and the dashboard. */
  label: string;
}

export function createVenueFeed(o: VenueOpts): VenueFeed {
  if (o.venue === "hyperliquid") {
    // Hyperliquid's own order books are the only way to measure spread, and it has no batch call, so the feed
    // tells the adapter which coins to quote (PublicApi.setBookCoins).
    const api = createHyperliquidPublicApi({
      testnet: !!o.demo,
      timeoutMs: o.timeoutMs,
      budgetPerMinute: o.weightBudgetPerMin,
    });
    return { api, venueFilter: hlVenueFilter, fundingPerDay: HL_FUNDING.perDay, label: o.demo ? "hyperliquid-testnet" : "hyperliquid" };
  }
  const api = createOkxPublicApi(o.okxApiBase, !!o.demo);
  // OKX's own instruments() already filters to X-Perps, so the venue filter is a no-op that keeps the
  // gateUniverse default honest.
  return { api, venueFilter: (id) => id.includes("_UM_XPERP-"), fundingPerDay: OKX_FUNDING.perDay, label: "okx-eea" };
}
