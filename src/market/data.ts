import { log } from "../log.js";
import type { PublicApi } from "./public-api.js";
import { safeError } from "../redact.js";
import { atr, bollinger, macd, pctChange, rsi, trendStats, zScore } from "./indicators.js";
import type { Candle, CoinStats, Instrument, MarketView, Ticker } from "./types.js";
import { gateUniverse } from "./universe.js";

export interface NewsReading {
  /** Hourly mention counts, oldest first (last = current hour). */
  mentions: number[];
  /** bullishRatio - bearishRatio for the latest period, -1..1. */
  sentiment: number | null;
}

/** News/sentiment source (the kit's `news` module). Returns null when unavailable. */
export type NewsSource = (coins: string[]) => Promise<Map<string, NewsReading> | null>;

export interface FeedOpts {
  min24hVolUsd: number;
  allowNonCrypto: boolean;
  /** The widest spread gate of any bee (boozy's), used for the shared universe. */
  spreadGateBps: number;
  /** Coins that always get stats + 4h trend data (breezy's majors). */
  trendCoins: string[];
  /** Which instIds this venue lists. Defaults to OKX EEA X-Perps (market/universe.ts). */
  venueFilter?: (instId: string) => boolean;
  /**
   * Settlements per day on this venue (OKX 3, Hyperliquid 24). Used to normalise the funding rate the bees and
   * the risk layer see, so an hourly rate is never compared against a threshold calibrated on 8-hourly rates.
   */
  fundingPerDay?: number;
  /**
   * How many of the gated coins get full stats (candles, indicators, funding, OI) per refresh.
   *
   * The gate is cheap (one snapshot covers every coin) but stats are not: each coin costs several candle calls,
   * and Hyperliquid charges a weight-based budget of 1200/min per IP. All 85 gated coins would need ~4100 weight
   * per refresh, so the feed would spend its whole minute on one cycle. The bees only ever look at the top of
   * the volume-sorted list (bizzy ~8, boozy 5 candidates, breezy 2 majors), so capping here costs them nothing.
   * `gated` itself stays complete, so the dashboard still reports the true universe size.
   */
  maxStatCoins?: number;
}

const HOUR = 3_600_000;
/** OKX EEA X-Perps settle funding every 8h; every funding threshold in the repo is calibrated on that. */
const FUNDING_PER_DAY_OKX = 3;

export function computeStats(inst: Instrument, t: Ticker, c15: Candle[], c1h: Candle[]): CoinStats {
  const closes15 = c15.map((c) => c.c);
  const closes1h = c1h.map((c) => c.c);
  const last = t.last;
  const bb = bollinger(c15);
  const a = atr(c15);
  const m = macd(closes15);
  const confirmed1h = c1h.filter((c) => c.confirmed);
  const volLatest = confirmed1h[confirmed1h.length - 1]?.volUsd;
  const volHist = confirmed1h.slice(-169, -1).map((c) => c.volUsd);
  return {
    instId: inst.instId,
    coin: inst.coin,
    last,
    mid: t.mid,
    bid: t.bid,
    ask: t.ask,
    spreadBp: t.spreadBp,
    vol24hUsd: t.vol24hUsd,
    rsi14: rsi(closes15),
    pctB: bb?.pctB ?? null,
    bbWidthPct: bb?.widthPct ?? null,
    bbMid: bb?.mid ?? null,
    atr14Pct: a !== null && last ? (a / last) * 100 : null,
    macdHistPct: m && last ? (m.hist / last) * 100 : null,
    ret1hPct: pctChange(closes15[closes15.length - 5], last),
    ret24hPct: pctChange(closes1h[closes1h.length - 25], last),
    ret7dPct: pctChange(closes1h[closes1h.length - 169], last),
    volZ: volLatest !== undefined ? zScore(volLatest, volHist) : null,
    fundingPct: null,
    fundingZ: null,
    oiUsd: null,
    oiChg1hPct: null,
    newsZ: null,
    sentiment: null,
  };
}

export class MarketFeed {
  private instruments = new Map<string, Instrument>();
  private tickers = new Map<string, Ticker>();
  private stats = new Map<string, CoinStats>();
  private gated: string[] = [];
  private spreadBlocked: string[] = [];
  private oiHistory = new Map<string, Array<[number, number]>>();
  private fundingHist = new Map<string, { at: number; rates: number[] }>();
  private instrumentsAt = 0;
  private newsAvailable = false;
  /** Settlements per day on this venue; the funding normaliser in `refresh`. */
  private fundingPerDay: number;
  lastRefreshAt = 0;
  /**
   * How long the last full refresh actually took.
   *
   * On a venue that charges a weight budget per minute (Hyperliquid) a refresh of N coins legitimately takes
   * tens of seconds, so a staleness threshold derived only from DATA_REFRESH_MS would declare fresh data stale
   * and freeze every bee. The engine scales its tolerance by this instead (see Engine.maxDataAge).
   */
  lastRefreshDurationMs = 0;

  constructor(
    private api: PublicApi,
    private opts: FeedOpts,
    private news: NewsSource | null,
    /** Coins currently held by any bee: they keep getting stats even if they drop out of the gate. */
    private heldInstIds: () => string[],
  ) {
    this.fundingPerDay = opts.fundingPerDay && opts.fundingPerDay > 0 ? opts.fundingPerDay : FUNDING_PER_DAY_OKX;
  }

  view(): MarketView {
    return {
      ts: this.lastRefreshAt,
      instruments: this.instruments,
      tickers: this.tickers,
      stats: this.stats,
      gated: this.gated,
      spreadBlocked: this.spreadBlocked,
      newsAvailable: this.newsAvailable,
    };
  }

  instIdForCoin(coin: string): string | undefined {
    for (const i of this.instruments.values()) if (i.coin === coin && i.state === "live") return i.instId;
    return undefined;
  }

  /** Every tick: re-read mark prices and volume. Cheap: one batched snapshot on every venue. */
  async refreshTickers(): Promise<void> {
    this.tickers = await this.api.tickers();
    for (const s of this.stats.values()) {
      const t = this.tickers.get(s.instId);
      if (!t) continue;
      s.last = t.last;
      s.mid = t.mid;
      s.bid = t.bid;
      s.ask = t.ask;
      s.spreadBp = t.spreadBp;
      s.vol24hUsd = t.vol24hUsd;
    }
  }

  /**
   * Re-measure spreads for the coins that matter.
   *
   * On OKX this is a no-op: its single tickers call already carries bid/ask for every instrument. On a venue
   * that charges one request per order book (Hyperliquid), doing this every tick would cost several times the
   * whole per-minute weight budget, so the feed calls it on the slow data-refresh cadence instead. Until the
   * first call lands, spreadBp is Infinity and the spread gate correctly holds every coin.
   */
  async refreshSpreads(): Promise<void> {
    if (!this.api.refreshSpreads) return;
    const coins = [...new Set([...this.gated, ...this.heldInstIds()])];
    await this.api.refreshSpreads(coins);
  }

  /** Every DATA_REFRESH_MS: universe gates, candles, indicators, funding, OI, news. */
  async refresh(now = Date.now()): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.refreshInner(now);
    } finally {
      // Recorded even on failure: a refresh that dies still took time, and the engine's staleness tolerance
      // must not shrink back to a value this venue cannot meet.
      this.lastRefreshDurationMs = Date.now() - startedAt;
    }
  }

  private async refreshInner(now: number): Promise<void> {
    if (now - this.instrumentsAt > HOUR || this.instruments.size === 0) {
      const list = await this.api.instruments();
      this.instruments = new Map(list.map((i) => [i.instId, i]));
      this.instrumentsAt = now;
    }
    // Spreads first: they are what the gate below measures, and on a per-book venue this is the expensive part.
    await this.refreshSpreads();
    const [tickers, oi] = await Promise.all([this.api.tickers(), this.api.openInterest()]);
    this.tickers = tickers;
    const u = gateUniverse(this.instruments.values(), tickers, {
      min24hVolUsd: this.opts.min24hVolUsd,
      spreadGateBps: this.opts.spreadGateBps,
      allowNonCrypto: this.opts.allowNonCrypto,
      venueFilter: this.opts.venueFilter,
    });
    this.gated = u.tradable;
    this.spreadBlocked = u.spreadBlocked;

    for (const [id, v] of oi) {
      const h = this.oiHistory.get(id) ?? [];
      h.push([now, v]);
      while (h.length && h[0]![0] < now - 2 * HOUR) h.shift();
      this.oiHistory.set(id, h);
    }

    const trendIds = this.opts.trendCoins.map((c) => this.instIdForCoin(c)).filter((x): x is string => !!x);
    // `gated` is volume-sorted, so the cap keeps the most liquid coins. Held positions and trend coins are
    // always included whatever their rank, so a bee never loses sight of a position it already has.
    const capped = this.opts.maxStatCoins && this.opts.maxStatCoins > 0 ? this.gated.slice(0, this.opts.maxStatCoins) : this.gated;
    const want = [...new Set([...capped, ...trendIds, ...this.heldInstIds()])].filter((id) => this.instruments.has(id) && tickers.has(id));

    const next = new Map<string, CoinStats>();
    await Promise.all(
      want.map(async (id) => {
        const inst = this.instruments.get(id)!;
        try {
          const isTrend = trendIds.includes(id);
          const [c15, c1h, c4h, funding, fHist] = await Promise.all([
            this.api.candles(id, "15m", 100),
            this.api.candles(id, "1H", 200),
            isTrend ? this.api.candles(id, "4H", 300) : Promise.resolve(null),
            this.api.funding(id).catch(() => null),
            this.fundingHistory(id, now),
          ]);
          const s = computeStats(inst, tickers.get(id)!, c15, c1h);
          if (funding && Number.isFinite(funding.rate)) {
            // Normalise to an 8-hour rate, the unit every threshold in this repo was calibrated on (OKX EEA
            // settles 3x/day). Hyperliquid settles hourly, so its raw rate is 1/8 of an 8h rate: without this
            // scaling the engine's 3x/day funding charge would collect only a third of what it should, and
            // `fundingPct` would not be comparable between venues. OKX (perDay = 3) is unchanged.
            s.fundingPct = funding.rate * 100 * (this.fundingPerDay / FUNDING_PER_DAY_OKX);
            // fundingZ stays the venue's own z-score: it measures how unusual this rate is *for this coin on
            // this venue*, so rescaling it would distort the comparison it is meant to make.
            s.fundingZ = fHist.length ? zScore(funding.rate, fHist) : null;
          }
          s.oiUsd = oi.get(id) ?? null;
          s.oiChg1hPct = this.oiChange1h(id, now);
          if (c4h) s.trend = trendStats(c4h);
          s.breakout = breakoutLevels(c1h, now, BREAKOUT_K);
          next.set(id, s);
        } catch (err) {
          log.warn("market data failed for coin", { instId: id, err: safeError(err) });
          const old = this.stats.get(id);
          if (old) next.set(id, old);
        }
      }),
    );

    if (this.news) {
      const coins = [...new Set([...next.values()].map((s) => s.coin))];
      const readings = await this.news(coins).catch(() => null);
      this.newsAvailable = readings !== null;
      if (readings) {
        for (const s of next.values()) {
          const r = readings.get(s.coin);
          if (!r || r.mentions.length < 6) continue;
          s.newsZ = zScore(r.mentions[r.mentions.length - 1]!, r.mentions.slice(0, -1));
          s.sentiment = r.sentiment;
        }
      }
    }

    this.stats = next;
    // Stamp the completion time, not the start: everything above is what makes the stats valid, and a slow
    // venue must not be judged stale by the clock it started on.
    this.lastRefreshAt = Date.now();
  }

  private oiChange1h(id: string, now: number): number | null {
    const h = this.oiHistory.get(id);
    if (!h || h.length < 2) return null;
    const cur = h[h.length - 1]![1];
    // oldest sample at least 55 min old, closest to 60 min
    const past = h.find(([t]) => t <= now - 55 * 60_000);
    return past ? pctChange(past[1], cur) : null;
  }

  private async fundingHistory(id: string, now: number): Promise<number[]> {
    const c = this.fundingHist.get(id);
    if (c && now - c.at < HOUR) return c.rates;
    try {
      const rates = await this.api.fundingHistory(id, 90); // 30 days x 3 settlements
      this.fundingHist.set(id, { at: now, rates });
      return rates;
    } catch {
      return c?.rates ?? [];
    }
  }
}

/** Larry Williams k: the trigger is today's open plus k x yesterday's high-low range (k = 0.5 in the source). */
export const BREAKOUT_K = 0.5;

/** Today's UTC-day open and yesterday's full range from 1h candles; null until a full previous day is available. */
export function breakoutLevels(c1h: Candle[], now: number, k: number): { dayOpen: number; prevRange: number; trigger: number } | null {
  const day = 86_400_000;
  const t0 = Math.floor(now / day) * day;
  const sorted = [...c1h].sort((a, b) => a.ts - b.ts);
  const today = sorted.filter((c) => c.ts >= t0);
  const prev = sorted.filter((c) => c.ts >= t0 - day && c.ts < t0);
  if (!today.length || prev.length < 20) return null;
  const dayOpen = today[0]!.o;
  const prevRange = Math.max(...prev.map((c) => c.h)) - Math.min(...prev.map((c) => c.l));
  return { dayOpen, prevRange, trigger: dayOpen + k * prevRange };
}
