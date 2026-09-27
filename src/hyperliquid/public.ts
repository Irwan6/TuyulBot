// Hyperliquid public market data, in-process against POST https://api.hyperliquid.xyz/info.
//
// Why this exists: from Indonesian ISPs (XL Axiata) the DNS for api.bybit.com, www.okx.com, eea.okx.com,
// fapi.binance.com and api.alpaca.markets resolves to blockpage.xlaxiata.id, while api.hyperliquid.xyz answers
// normally. So this adapter is the venue that actually reaches the engine from the user's own network.
//
// Notes that differ from OKX and are easy to get wrong:
// - Candles accept ONLY lowercase intervals: "15m" | "1h" | "4h". "1H"/"4H" fail to deserialise.
// - There is no per-candle "confirmed" flag. A bar is confirmed when its close time (T) is in the past; the
//   in-progress bar must be marked unconfirmed or computeStats' volZ and breakoutLevels read a partial bar.
// - `funding` is charged HOURLY, not every 8h like OKX (see VenueFunding in market/public-api.ts).
// - `dayNtlVlm` is already USD notional, so vol24hUsd needs no multiplication (OKX needed base x last).
// - `openInterest` is in COINS, not USD, so it is multiplied by the mark price.
// - Prices/sizes arrive as decimal STRINGS; nothing may be trusted to be a number.
// - There is no batch endpoint: 60 order books are 60 POSTs. The feed only needs books for gated coins, and the
//   metaAndAssetCtxs snapshot already carries a mid price for everything else.

import { kindOf } from "../market/kinds.js";
import type { PublicApi, VenueFunding } from "../market/public-api.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";
import { WeightLimiter, HL_WEIGHT } from "./rate-limit.js";

const MAINNET = "https://api.hyperliquid.xyz";
const TESTNET = "https://api.hyperliquid-testnet.xyz";

/** Hyperliquid settles funding once an hour. */
export const HL_FUNDING: VenueFunding = { perDay: 24, intervalHours: 1 };

/**
 * Which Hyperliquid instIds the engine may trade: bare coin names on the main perp dex.
 *
 * HIP-3 builder perps ("xyz:AAPL", "xyz:ALUMINIUM") are excluded here and resolve to "unknown" in kinds.ts
 * anyway. They are tokenised equities/commodities with their own trading hours, and this repo gates those
 * behind ALLOW_NON_CRYPTO, which stays false until those hours are verified.
 */
export const hlVenueFilter = (instId: string): boolean => !instId.includes(":");

/** How many top-volume coins to quote when the feed has not named a set. Covers every coin above $1M/day. */
const DEFAULT_BOOK_COINS = 150;

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

type Meta = { universe: Array<{ name: string; szDecimals?: number; maxLeverage?: number; isDelisted?: boolean }> };
type Ctx = Record<string, unknown>;

export interface HyperliquidOpts {
  /** Testnet base URL when MODE=demo, so the whole feed matches the account the executor trades on. */
  testnet?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** How many book requests may be in flight at once. */
  maxConcurrent?: number;
  /** Weight budget per minute for the /info API (Hyperliquid allows 1200; the limiter keeps headroom). */
  budgetPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HyperliquidPublicRest extends PublicApi {
  readonly kind: "hyperliquid";
  readonly baseUrl: string;
}

/**
 * One POST /info call, charged against the shared weight budget and retried on 429.
 *
 * `cost` is the endpoint's weight (see HL_WEIGHT). The limiter waits before sending rather than after failing,
 * so a steady state should never see a 429; the retry below only covers a burst that still slips through.
 */
async function info<T>(
  baseUrl: string,
  body: unknown,
  timeoutMs: number,
  f: typeof globalThis.fetch,
  limiter: WeightLimiter,
  cost: { base: number; extra?: number },
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    await limiter.consume(cost);
    const res = await f(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    // 429 means the window is full: wait it out and try again rather than dropping the coin for this cycle.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Hyperliquid answered HTTP ${res.status}: ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Hyperliquid sent a non-JSON body: ${text.slice(0, 160)}`);
    }
  }
}

export function parseHlInstrument(u: Meta["universe"][number]): Instrument {
  const coin = u.name;
  // Hyperliquid has no contract multiplier: 1 contract = 1 coin. Sizes are decimal, 10^-szDecimals steps.
  const szDecimals = Number.isFinite(num(u.szDecimals)) ? num(u.szDecimals) : 0;
  const lotSz = Number((10 ** -szDecimals).toFixed(szDecimals));
  return {
    instId: coin,
    coin,
    kind: kindOf(coin),
    ctVal: 1,
    lotSz,
    minSz: lotSz,
    // Hyperliquid allows 5 significant figures and at most (6 - szDecimals) decimals for prices; the exact tick
    // depends on the price level, so this is a floor used only for formatting, never for rounding decisions.
    tickSz: Number((10 ** -(6 - szDecimals)).toFixed(6 - szDecimals)),
    state: u.isDelisted ? "delisted" : "live",
  };
}

/** A ticker from the metaAndAssetCtxs snapshot. `book` (when present) gives a real spread instead of an estimate. */
export function parseHlTicker(coin: string, ctx: Ctx, book?: { bid: number; ask: number }): Ticker {
  const last = num(ctx.markPx);
  const midPx = num(ctx.midPx);
  const bid = book?.bid ?? (Number.isFinite(midPx) ? midPx : last);
  const ask = book?.ask ?? (Number.isFinite(midPx) ? midPx : last);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  return {
    instId: coin,
    last,
    bid,
    ask,
    mid,
    // With no book the spread is unknown, so report Infinity: gateUniverse must NOT let an unmeasured coin
    // through the spread gate on an optimistic guess.
    spreadBp: book && mid > 0 ? ((ask - bid) / mid) * 10_000 : Infinity,
    // dayNtlVlm is already USD notional.
    vol24hUsd: num(ctx.dayNtlVlm),
    open24h: num(ctx.prevDayPx),
    ts: Date.now(),
  };
}

/** Hyperliquid candles: newest last, strings, and `T` is the bar's close time. */
export function parseHlCandles(rows: Array<Record<string, unknown>>, now = Date.now()): Candle[] {
  return rows
    .map((r) => {
      const close = num(r.c);
      return {
        ts: num(r.t),
        o: num(r.o),
        h: num(r.h),
        l: num(r.l),
        c: close,
        // `v` is base volume; USD notional is base x close (OKX supplied the quote volume directly).
        volUsd: num(r.v) * close,
        // There is no confirm flag: a bar is complete once its close time has passed.
        confirmed: num(r.T) < now,
      };
    })
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.c))
    .sort((a, b) => a.ts - b.ts);
}

const BAR: Record<"15m" | "1H" | "4H", string> = { "15m": "15m", "1H": "1h", "4H": "4h" };
const BAR_MS: Record<"15m" | "1H" | "4H", number> = { "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000 };

/**
 * Public Hyperliquid market data. One metaAndAssetCtxs call covers instruments, tickers, volume, funding and
 * open interest, so a refresh is cheap; order books are fetched only for the coins that need a measured spread.
 */
export function createHyperliquidPublicApi(opts: HyperliquidOpts = {}): HyperliquidPublicRest {
  const baseUrl = (opts.testnet ? TESTNET : MAINNET).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const f = opts.fetch ?? globalThis.fetch;
  const maxConcurrent = opts.maxConcurrent ?? 8;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // One limiter per adapter, shared by every call: the upstream budget is per IP, not per endpoint.
  const limiter = new WeightLimiter({ budgetPerMinute: opts.budgetPerMinute, now: opts.now, sleep });
  const call = <T,>(body: unknown, cost: { base: number; extra?: number }) => info<T>(baseUrl, body, timeoutMs, f, limiter, cost, sleep);

  // metaAndAssetCtxs is the one expensive-but-shared call: cache it briefly so the several methods that need it
  // in one engine cycle (instruments, tickers, openInterest, funding) hit the network once.
  let snapshot: { at: number; meta: Meta; ctxs: Ctx[] } | null = null;
  let inflight: Promise<{ meta: Meta; ctxs: Ctx[] }> | null = null;
  const SNAPSHOT_TTL_MS = 5_000;

  const load = async (): Promise<{ meta: Meta; ctxs: Ctx[] }> => {
    if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return { meta: snapshot.meta, ctxs: snapshot.ctxs };
    if (inflight) return inflight;
    inflight = call<[Meta, Ctx[]]>({ type: "metaAndAssetCtxs" }, HL_WEIGHT.metaAndAssetCtxs)
      .then(([meta, ctxs]) => {
        snapshot = { at: Date.now(), meta, ctxs };
        return { meta, ctxs };
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  /** coin -> ctx, skipping delisted entries (the two arrays are positional and the same length). */
  const ctxByCoin = async (): Promise<{ meta: Meta; byCoin: Map<string, Ctx> }> => {
    const { meta, ctxs } = await load();
    const byCoin = new Map<string, Ctx>();
    for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
      const u = meta.universe[i]!;
      if (u.isDelisted) continue;
      byCoin.set(u.name, ctxs[i]!);
    }
    return { meta, byCoin };
  };

  /** Order books for the requested coins, at most `maxConcurrent` in flight. */
  const books = async (coins: string[]): Promise<Map<string, { bid: number; ask: number }>> => {
    const out = new Map<string, { bid: number; ask: number }>();
    const queue = [...coins];
    const worker = async () => {
      for (;;) {
        const coin = queue.shift();
        if (!coin) return;
        try {
          const r = await call<{ levels: Array<Array<{ px: string }>> }>({ type: "l2Book", coin }, HL_WEIGHT.l2Book);
          const bid = num(r.levels?.[0]?.[0]?.px);
          const ask = num(r.levels?.[1]?.[0]?.px);
          if (bid > 0 && ask > 0) out.set(coin, { bid, ask });
        } catch {
          // No book => spreadBp Infinity => the spread gate holds this coin this cycle. Never guess a spread.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, Math.max(1, coins.length)) }, worker));
    return out;
  };

  const fundingByCoin = new Map<string, FundingNow>();
  /** Last measured order book per coin, refreshed by refreshSpreads() on the slow cadence. */
  const bookCache = new Map<string, { bid: number; ask: number; at: number }>();
  /** How long a cached book stays usable. Spread moves, but not enough to re-quote 86 coins every tick. */
  const BOOK_TTL_MS = 120_000;

  return {
    kind: "hyperliquid",
    baseUrl,

    async refreshSpreads(coins: string[]) {
      const { byCoin } = await ctxByCoin();
      // Quote the named coins, plus the most liquid ones when the feed has not named a set. That fallback is
      // what the very first refresh needs: without it the spread gate is a chicken-and-egg problem, since the
      // gate cannot run without books and the feed cannot name coins until the gate has run once.
      let want = coins.filter((c) => byCoin.has(c));
      if (!want.length) {
        want = [...byCoin.entries()]
          .sort((a, b) => num(b[1].dayNtlVlm) - num(a[1].dayNtlVlm))
          .slice(0, DEFAULT_BOOK_COINS)
          .map(([coin]) => coin);
      }
      // Skip books measured recently: they are already fresh enough for a 5 bp gate.
      const now = Date.now();
      want = want.filter((c) => now - (bookCache.get(c)?.at ?? 0) > BOOK_TTL_MS);
      if (!want.length) return;
      const fresh = await books(want);
      for (const [coin, b] of fresh) bookCache.set(coin, { ...b, at: now });
    },

    async instruments() {
      const { meta } = await load();
      return meta.universe.filter((u) => !u.isDelisted).map(parseHlInstrument);
    },

    async tickers() {
      // Mark prices, volume, funding and OI all come from the one cached snapshot: no per-coin request here.
      const { meta, byCoin } = await ctxByCoin();
      const out = new Map<string, Ticker>();
      for (const u of meta.universe) {
        const ctx = byCoin.get(u.name);
        if (!ctx) continue;
        const cached = bookCache.get(u.name);
        out.set(u.name, parseHlTicker(u.name, ctx, cached ? { bid: cached.bid, ask: cached.ask } : undefined));
      }
      return out;
    },

    async candles(instId, bar, limit) {
      const interval = BAR[bar];
      // Ask for a little more than `limit` so the in-progress bar can be dropped without shrinking the history.
      const startTime = Date.now() - Math.ceil(limit * BAR_MS[bar] * 1.15);
      const rows = await call<Array<Record<string, unknown>>>(
        { type: "candleSnapshot", req: { coin: instId, interval, startTime } },
        // Weight depends on bars returned; `limit` is the floor, the API may send slightly more.
        HL_WEIGHT.candles(limit),
      );
      if (!Array.isArray(rows)) throw new Error(`Hyperliquid sent no candles for ${instId} ${interval}`);
      const parsed = parseHlCandles(rows);
      // Newest-last, like OKX's parser. Keep the most recent `limit` bars, unconfirmed tail included: the
      // indicator code already filters on `confirmed` where a completed bar matters.
      return parsed.slice(-limit);
    },

    async openInterest() {
      const { byCoin } = await ctxByCoin();
      const out = new Map<string, number>();
      for (const [coin, ctx] of byCoin) {
        const oi = num(ctx.openInterest);
        const px = num(ctx.markPx);
        // openInterest is in coins; the engine's oiUsd is USD notional.
        if (Number.isFinite(oi) && Number.isFinite(px)) out.set(coin, oi * px);
      }
      return out;
    },

    async funding(instId) {
      const { byCoin } = await ctxByCoin();
      const ctx = byCoin.get(instId);
      const rate = num(ctx?.funding);
      const cached = fundingByCoin.get(instId);
      if (Number.isFinite(rate)) {
        // Keep the last good rate so a coin that drops out of the snapshot does not look like zero funding.
        fundingByCoin.set(instId, { rate, nextFundingTime: nextFundingTime() });
        return fundingByCoin.get(instId)!;
      }
      if (cached) return cached;
      throw new Error(`no funding for ${instId}`);
    },

    async fundingHistory(instId, limit) {
      // Hourly settlements, newest last, capped at 500 by the API regardless of `limit`.
      const want = Math.min(limit, 500);
      const rows = await call<Array<{ fundingRate: string }>>(
        { type: "fundingHistory", coin: instId, startTime: Date.now() - want * 3_600_000 },
        HL_WEIGHT.fundingHistory(want),
      );
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => num(r.fundingRate)).filter(Number.isFinite);
    },
  };
}

/** Hyperliquid settles funding on the hour, so the next settlement is the top of the next hour. */
function nextFundingTime(now = Date.now()): number {
  const HOUR = 3_600_000;
  return Math.ceil((now + 1) / HOUR) * HOUR;
}

export { info as hyperliquidInfo, MAINNET as HL_MAINNET, TESTNET as HL_TESTNET };
