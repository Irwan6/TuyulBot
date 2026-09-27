import type { Instrument, Ticker } from "./types.js";

export interface UniverseResult {
  /** Passed every gate, ranked by 24h USD volume. */
  tradable: string[];
  /** Passed volume but failed the spread gate. */
  spreadBlocked: string[];
  /** Live instruments we could not classify (never traded). */
  unknown: string[];
}

export interface GateOpts {
  min24hVolUsd: number;
  spreadGateBps: number;
  allowNonCrypto: boolean;
  /**
   * Only coins this venue lists may trade. Defaults to the OKX EEA X-Perp suffix so existing behaviour (and
   * every test written against it) is unchanged; Hyperliquid passes a plain-set predicate because its instIds
   * are bare coin names ("BTC"), not "BTC-USDT-SWAP"-shaped.
   */
  venueFilter?: (instId: string) => boolean;
}

/** OKX EEA lists X-Perps only, and their instIds carry this marker. */
const okxXperp = (instId: string) => instId.includes("_UM_XPERP-");

/** Hard rule 5: discover, never hard-code. Live, venue-listed, not TEST*, crypto unless allowed, volume and spread gates. */
export function gateUniverse(instruments: Iterable<Instrument>, tickers: Map<string, Ticker>, g: GateOpts): UniverseResult {
  const onVenue = g.venueFilter ?? okxXperp;
  const tradable: Array<[string, number]> = [];
  const spreadBlocked: string[] = [];
  const unknown: string[] = [];
  for (const i of instruments) {
    if (i.state !== "live" || !onVenue(i.instId) || i.coin.startsWith("TEST")) continue;
    if (i.kind === "unknown") {
      unknown.push(i.instId);
      continue;
    }
    if (i.kind === "test") continue;
    if (i.kind !== "crypto" && !g.allowNonCrypto) continue;
    const t = tickers.get(i.instId);
    if (!t || !(t.vol24hUsd >= g.min24hVolUsd)) continue;
    if (!(t.spreadBp <= g.spreadGateBps)) {
      spreadBlocked.push(i.instId);
      continue;
    }
    tradable.push([i.instId, t.vol24hUsd]);
  }
  tradable.sort((a, b) => b[1] - a[1]);
  return { tradable: tradable.map(([id]) => id), spreadBlocked, unknown };
}
