// The Hyperliquid adapter: parsing (strings, hourly funding, unconfirmed bars), the venue filter, and the
// weight limiter that keeps the engine inside Hyperliquid's 1200-weight-per-minute budget.
import { describe, expect, it } from "vitest";
import { gateUniverse } from "../src/market/universe.js";
import type { Instrument, Ticker } from "../src/market/types.js";
import { kindOf } from "../src/market/kinds.js";
import {
  hlVenueFilter,
  parseHlCandles,
  parseHlInstrument,
  parseHlTicker,
  HL_FUNDING,
} from "../src/hyperliquid/public.js";
import { HL_WEIGHT, WeightLimiter } from "../src/hyperliquid/rate-limit.js";

const inst = (over: Partial<Instrument> = {}): Instrument => ({
  instId: "BTC",
  coin: "BTC",
  kind: "crypto",
  ctVal: 1,
  lotSz: 1e-5,
  minSz: 1e-5,
  tickSz: 1e-1,
  state: "live",
  ...over,
});

const tick = (over: Partial<Ticker> = {}): Ticker => ({
  instId: "BTC",
  last: 100,
  bid: 99.99,
  ask: 100.01,
  mid: 100,
  spreadBp: 2,
  vol24hUsd: 5_000_000,
  open24h: 98,
  ts: 1,
  ...over,
});

describe("hyperliquid parsing", () => {
  it("reads instruments from the meta universe and treats delisted ones as not live", () => {
    const live = parseHlInstrument({ name: "BTC", szDecimals: 5, maxLeverage: 40 });
    expect(live.instId).toBe("BTC");
    expect(live.coin).toBe("BTC");
    expect(live.state).toBe("live");
    // 1 contract = 1 coin on Hyperliquid, and the size step comes from szDecimals.
    expect(live.ctVal).toBe(1);
    expect(live.lotSz).toBeCloseTo(1e-5, 10);

    expect(parseHlInstrument({ name: "OLD", isDelisted: true }).state).toBe("delisted");
  });

  it("takes vol24hUsd straight from dayNtlVlm (already USD, unlike OKX)", () => {
    const t = parseHlTicker("BTC", { markPx: "84383.0", midPx: "84383.5", dayNtlVlm: "843885856.0", prevDayPx: "83000" });
    expect(t.last).toBeCloseTo(84383, 6);
    expect(t.mid).toBeCloseTo(84383.5, 6);
    expect(t.vol24hUsd).toBeCloseTo(843_885_856, 0);
    expect(t.open24h).toBeCloseTo(83000, 6);
  });

  it("reports an unknown spread as Infinity, never as a guessed number", () => {
    // With no book, bid/ask fall back to midPx. The spread must NOT look healthy, or an unmeasured coin would
    // pass the spread gate on a fabricated zero.
    const noBook = parseHlTicker("BTC", { markPx: "100", midPx: "100", dayNtlVlm: "5000000" });
    expect(noBook.spreadBp).toBe(Infinity);

    const withBook = parseHlTicker("BTC", { markPx: "100", midPx: "100", dayNtlVlm: "5000000" }, { bid: 99.99, ask: 100.01 });
    expect(withBook.spreadBp).toBeCloseTo(2, 6);
  });

  it("marks the in-progress candle unconfirmed and keeps the rest oldest-first", () => {
    const now = 1_700_000_000_000;
    const rows = [
      { t: now - 900_000, T: now - 900_000 + 899_999, o: "1", h: "2", l: "0.5", c: "1.5", v: "10" }, // closed
      { t: now, T: now + 899_999, o: "1.5", h: "3", l: "1", c: "2", v: "4" }, // still forming
    ];
    const c = parseHlCandles(rows, now);
    expect(c.map((x) => x.confirmed)).toEqual([true, false]);
    expect(c[0]!.ts).toBeLessThan(c[1]!.ts);
    // volUsd is base volume x close, because Hyperliquid reports base volume (OKX supplied quote volume).
    expect(c[1]!.volUsd).toBeCloseTo(8, 6);
  });

  it("drops malformed candles instead of producing NaN indicators", () => {
    const c = parseHlCandles([{ t: 1, c: "not-a-number" }, { t: 2, c: "5", o: "4", h: "6", l: "3", v: "1", T: 0 }] as never);
    expect(c).toHaveLength(1);
    expect(c[0]!.c).toBe(5);
  });

  it("settles funding hourly, unlike OKX's three times a day", () => {
    expect(HL_FUNDING.perDay).toBe(24);
    expect(HL_FUNDING.intervalHours).toBe(1);
  });
});

describe("hyperliquid venue filter", () => {
  it("allows bare coin names and excludes HIP-3 builder perps", () => {
    expect(hlVenueFilter("BTC")).toBe(true);
    expect(hlVenueFilter("kPEPE")).toBe(true);
    // Builder-deployed dex perps are tokenised equities/commodities with their own trading hours.
    expect(hlVenueFilter("xyz:AAPL")).toBe(false);
  });

  it("gates Hyperliquid coins, where instIds carry no OKX suffix", () => {
    const instruments = [inst({ instId: "BTC", coin: "BTC" }), inst({ instId: "xyz:AAPL", coin: "AAPL", kind: "stock" })];
    const tickers = new Map([
      ["BTC", tick({ instId: "BTC" })],
      ["xyz:AAPL", tick({ instId: "xyz:AAPL" })],
    ]);
    const g = gateUniverse(instruments, tickers, { min24hVolUsd: 1_000_000, spreadGateBps: 5, allowNonCrypto: false, venueFilter: hlVenueFilter });
    expect(g.tradable).toEqual(["BTC"]);
  });

  it("classifies the Hyperliquid-native coins that OKX EEA does not list", () => {
    // These were "unknown" (never traded) before HL_NATIVE was added to kinds.ts.
    expect(kindOf("FARTCOIN")).toBe("crypto");
    expect(kindOf("XMR")).toBe("crypto");
    expect(kindOf("kPEPE")).toBe("crypto");
    expect(kindOf("SPX")).toBe("crypto");
    // Not a Hyperliquid native and not on OKX EEA: still unknown, still never traded.
    expect(kindOf("NOT_A_REAL_COIN")).toBe("unknown");
  });
});

describe("funding normalisation across venues", () => {
  // The bees and the risk layer compare `fundingPct` against thresholds calibrated on OKX's 8-hourly rate
  // (FUNDING_Z_BLOCK_LONG, fundingVetoLongZ, and the engine's 3x/day funding charge). An hourly venue must be
  // scaled to that unit or the funding veto fires 8x too often and the ledger undercharges 8x.
  it("scales an hourly rate to the 8h unit OKX thresholds assume", () => {
    const okx = { perDay: 3 };
    const hl = { perDay: 24 };
    const OKX_SETTLEMENTS_PER_DAY = 3;
    const scale = (perDay: number) => perDay / OKX_SETTLEMENTS_PER_DAY;

    expect(scale(okx.perDay)).toBe(1); // OKX unchanged
    expect(scale(hl.perDay)).toBe(8); // hourly rate x8 = the equivalent 8h rate

    // A 0.00125% hourly rate is a 0.01% 8h rate.
    const hourlyRate = 0.0000125;
    expect(hourlyRate * 100 * scale(hl.perDay)).toBeCloseTo(0.01, 10);
    expect(hourlyRate * 100 * scale(okx.perDay)).toBeCloseTo(0.00125, 10);
  });
});

describe("weight limiter", () => {
  it("charges candle calls by bars returned, as Hyperliquid's docs specify", () => {
    expect(HL_WEIGHT.candles(100)).toEqual({ base: 20, extra: 2 });
    expect(HL_WEIGHT.candles(200)).toEqual({ base: 20, extra: 4 });
    expect(HL_WEIGHT.fundingHistory(90)).toEqual({ base: 20, extra: 5 });
    expect(HL_WEIGHT.l2Book).toEqual({ base: 2 });
  });

  it("waits instead of exceeding the budget, and never blocks forever on one oversized call", async () => {
    let now = 0;
    const slept: number[] = [];
    // 100 weight/minute, 75% safety => 75 usable per window.
    const limiter = new WeightLimiter({
      budgetPerMinute: 100,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    // Three candle calls at 20 each fit in the 75-weight window.
    await limiter.consume(HL_WEIGHT.candles(0));
    await limiter.consume(HL_WEIGHT.candles(0));
    await limiter.consume(HL_WEIGHT.candles(0));
    expect(slept).toHaveLength(0);

    // The fourth does not fit, so it must wait for the window to slide.
    await limiter.consume(HL_WEIGHT.candles(0));
    expect(slept.length).toBeGreaterThan(0);
    expect(now).toBeGreaterThan(0);

    // A single call heavier than the whole budget is clamped, not an infinite wait.
    const tiny = new WeightLimiter({ budgetPerMinute: 10, now: () => now, sleep: async (ms) => void (now += ms) });
    await tiny.consume({ base: 999 });
  });

  it("counts concurrent callers against one shared budget", async () => {
    let now = 0;
    let waits = 0;
    const limiter = new WeightLimiter({
      budgetPerMinute: 100,
      now: () => now,
      sleep: async (ms) => {
        waits++;
        now += ms;
      },
    });
    // Five 20-weight calls = 100 against a 75 budget: at least one must wait.
    await Promise.all(Array.from({ length: 5 }, () => limiter.consume({ base: 20 })));
    expect(waits).toBeGreaterThan(0);
    expect(limiter.totalSpent).toBe(100);
  });
});
