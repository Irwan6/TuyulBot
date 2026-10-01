// Hyperliquid signed executor: real orders, signed with an EVM key (EIP-712), no API key/secret.
//
// Auth model (why this is safe to run unattended):
//   The engine signs with an AGENT (API) wallet, never the main wallet. Hyperliquid refuses to let an agent
//   withdraw or transfer, so a leaked agent key can trade and can be revoked, but it cannot move funds out.
//   That matches this repo's promise for OKX keys ("Read + Trade only, never Withdraw").
//
// What is NOT like OKX, and is easy to get wrong:
//   - Orders address an integer ASSET INDEX from the `meta` universe, not a coin name. The index is looked up
//     live and cached, because a stale hard-coded table would silently trade the wrong coin.
//   - There is no "isolated margin mode per order": leverage is set per coin with `updateLeverage`
//     (isCross: false = isolated) before the first order on that coin.
//   - Sizes and prices are decimal STRINGS with 5-significant-figure price rules, so everything is formatted
//     from the instrument's `lotSz` rather than passed as a JS float.
//   - `userFills` is per user, not per coin, and reports `fee` as a POSITIVE number of USDC paid.
//   - A market order is a limit order with tif "Ioc" at a slippage-bounded price. There is no "market" type.

import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { BeeId } from "../config.js";
import { log } from "../log.js";
import type { Instrument } from "../market/types.js";
import { safeError } from "../redact.js";
import type { ExchangePosition, Executor, FundingBill, OrderReq, OrderResult } from "./executor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Hyperliquid requires 5 significant figures and at most (6 - szDecimals) decimals for a price. */
export function formatPx(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  // Round to 5 significant figures first, then clamp the decimals.
  const sig = Number(px.toPrecision(5));
  return sig.toFixed(maxDecimals);
}

/** Sizes are base-currency decimals with `szDecimals` places, always rounded DOWN so a close never over-fills. */
export function formatSz(contracts: number, lotSz: number): string {
  const decimals = lotSz >= 1 ? 0 : Math.max(0, Math.round(-Math.log10(lotSz)));
  const step = 10 ** -decimals;
  const floored = Math.floor(contracts / step + 1e-9) * step;
  return floored.toFixed(decimals);
}

/**
 * A venue rejection arrives as `ApiRequestError` with the venue's own words. Keeping those words in a `HL`
 * code is what makes a ledger row diagnosable; `safeError` would flatten it to the useless class name.
 */
function hlError(err: unknown): { code: string; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  return { code: "HL", message: msg.slice(0, 300) };
}

export interface HyperliquidExecutorOpts {
  /** One agent-wallet private key per bee. Never logged; only the derived address is ever shown. */
  agentKeys: Partial<Record<BeeId, `0x${string}`>>;
  /** Main wallet address per bee: the account whose positions are read. The agent only signs. */
  accounts: Partial<Record<BeeId, `0x${string}`>>;
  /** testnet when MODE=demo. */
  testnet: boolean;
  /** Leverage to set per coin (repo hard rule: max 2). */
  leverage: number;
  /** Slippage bound for the aggressive-IOC "market" order, in basis points. */
  slippageBps?: number;
  /**
   * Minimum order notional. Hyperliquid rejects anything under $10 outright, so a smaller size is refused here
   * with a clear code instead of round-tripping to the venue for a confusing error.
   */
  minNotionalUsd?: number;
  /**
   * Taker fee rate used when the order ack does not carry a fee (it never does; fills do).
   * Measured on mainnet from real fills: ~0.0458% taker, ~0.0036% maker. Kept as a parameter because it
   * changes with the user's VIP tier, and reconciliation replaces the estimate with the real fill anyway.
   */
  takerFeeRate?: number;
  instrument: (instId: string) => Instrument | undefined;
  /** Live mid price, so a market order can be priced without a book round-trip. */
  midFor: (instId: string) => number | undefined;
  now?: () => number;
}

type Position = {
  position: { coin: string; szi: string; entryPx: string };
};

export class HyperliquidExecutor implements Executor {
  readonly kind = "hyperliquid" as const;
  private transport: HttpTransport;
  private info: InfoClient;
  private exch = new Map<BeeId, ExchangeClient>();
  /** Agent address per bee, for logs. The private key is never stored beyond the client. */
  private agentAddr = new Map<BeeId, string>();
  /** coin -> asset index from `meta`. Cached per process; a coin missing here is refused, never guessed. */
  private assetIndex = new Map<string, number>();
  private leverageSet = new Set<string>();
  /** ordId -> coin, so feesFor() can map a fill back without another lookup. */
  private ordCoin = new Map<string, string>();
  private now: () => number;

  constructor(private o: HyperliquidExecutorOpts) {
    this.now = o.now ?? Date.now;
    this.transport = new HttpTransport({ isTestnet: o.testnet });
    this.info = new InfoClient({ transport: this.transport });
    for (const [bee, key] of Object.entries(o.agentKeys) as Array<[BeeId, `0x${string}`]>) {
      if (!key) continue;
      // An address pasted where the private key belongs is the most common mistake, and viem's error for it
      // ("expected hex or 32 bytes") never says so. Name the problem at the point where it is knowable.
      if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
        throw new Error(
          `${bee}: BEE<n>_HL_AGENT_KEY looks like an ADDRESS (0x + 40 hex), not a private key (0x + 64 hex).\n` +
            `  ${key} is the API wallet's public address. The private key was shown once by "Generate Wallet\n` +
            `  Address" on app.hyperliquid.xyz/API and cannot be displayed again — revoke this agent and create\n` +
            `  a new one if it was not saved.`,
        );
      }
      const account = privateKeyToAccount(key);
      this.agentAddr.set(bee, account.address);
      this.exch.set(bee, new ExchangeClient({ wallet: account, transport: this.transport }));
    }
  }

  /** Address that signs for a bee (the agent), for logs. Never the key. */
  agentAddress(bee: BeeId): string | null {
    return this.agentAddr.get(bee) ?? null;
  }

  async init(bee: BeeId): Promise<void> {
    if (!this.exch.has(bee)) throw new Error(`no Hyperliquid agent key for ${bee}`);
    const account = this.o.accounts[bee];
    if (!account) throw new Error(`no Hyperliquid account address for ${bee}`);
    const meta = await this.info.meta();
    meta.universe.forEach((u, i) => this.assetIndex.set(u.name, i));
    log.info("hyperliquid executor ready", { bee, agent: this.agentAddress(bee), coins: meta.universe.length });
    await this.warnIfAgentExpiring(bee, account);
  }

  /**
   * An API wallet expires (180 days maximum), and when it does every order starts failing with a venue error
   * mid-run. Warn well before that so it is a scheduled rotation, not an outage.
   */
  private async warnIfAgentExpiring(bee: BeeId, account: `0x${string}`): Promise<void> {
    const agent = this.agentAddr.get(bee);
    if (!agent) return;
    try {
      const agents = (await this.info.extraAgents({ user: account })) as unknown as Array<{
        address?: string;
        name?: string;
        validUntil?: number;
      }>;
      // Only NAMED agents appear here; an unnamed one is still valid, so a miss is not an error.
      const mine = agents.find((a) => a.address?.toLowerCase() === agent.toLowerCase());
      if (!mine?.validUntil) return;
      const days = (mine.validUntil - this.now()) / 86_400_000;
      if (days < 30) {
        log.warn("hyperliquid agent wallet expires soon; rotate it in the Hyperliquid UI", {
          bee,
          name: mine.name,
          days: Math.max(0, Math.round(days)),
        });
      }
    } catch {
      /* the check is advisory: never block a bee because it failed */
    }
  }

  /** Asset index for a coin, refreshing the table once if it is missing (a newly listed perp). */
  private async asset(bee: BeeId, coin: string): Promise<number> {
    const hit = this.assetIndex.get(coin);
    if (hit !== undefined) return hit;
    const meta = await this.info.meta();
    meta.universe.forEach((u, i) => this.assetIndex.set(u.name, i));
    const again = this.assetIndex.get(coin);
    if (again === undefined) throw new Error(`Hyperliquid has no perp named ${coin}`);
    return again;
  }

  private client(bee: BeeId): ExchangeClient {
    const c = this.exch.get(bee);
    if (!c) throw new Error(`no Hyperliquid agent key for ${bee}`);
    return c;
  }

  /** Isolated leverage, set once per coin, before the first order that opens on it. */
  private async ensureLeverage(bee: BeeId, coin: string): Promise<void> {
    const key = `${bee}:${coin}`;
    if (this.leverageSet.has(key)) return;
    await this.client(bee).updateLeverage({ asset: await this.asset(bee, coin), isCross: false, leverage: this.o.leverage });
    this.leverageSet.add(key);
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const coin = req.instId;
    const inst = this.o.instrument(coin);
    if (!inst) return { ok: false, error: { code: "INST", message: "unknown instrument" }, state: "rejected" };
    const sz = formatSz(req.contracts, inst.lotSz);
    if (!(Number(sz) > 0)) return { ok: false, error: { code: "SIZE", message: `size ${req.contracts} rounds to 0 at lotSz ${inst.lotSz}` }, state: "rejected" };

    try {
      if (!req.reduceOnly) await this.ensureLeverage(bee, coin);
      const mid = this.o.midFor(coin);
      if (!mid || !(mid > 0)) return { ok: false, error: { code: "PRICE", message: "no mid price for market order" }, state: "rejected" };
      // Hyperliquid rejects any order below a $10 notional. Checking it here turns a confusing venue rejection
      // into a clear skip, and it is the one gate that can make a whole coin untradable (see MIN_NOTIONAL in
      // the notes: a coin whose minimum lot is worth more than $10 can never be traded at all).
      const notional = req.contracts * inst.ctVal * mid;
      const minNotional = this.o.minNotionalUsd ?? 10;
      if (notional < minNotional) {
        return {
          ok: false,
          error: { code: "MIN_NOTIONAL", message: `notional $${notional.toFixed(2)} is below Hyperliquid's $${minNotional} minimum` },
          state: "rejected",
        };
      }
      // Hyperliquid has no market order type: this is an IOC limit priced through the touch by the slippage
      // bound, which is what its own frontend does. The bound is what protects the fill, not the order type.
      const slip = (this.o.slippageBps ?? 50) / 10_000;
      const px = formatPx(req.side === "buy" ? mid * (1 + slip) : mid * (1 - slip), inst.lotSz >= 1 ? 0 : Math.max(0, Math.round(-Math.log10(inst.lotSz))));

      const res = await this.client(bee).order({
        orders: [
          {
            a: await this.asset(bee, coin),
            b: req.side === "buy",
            p: px,
            s: sz,
            r: req.reduceOnly,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });

      const status = (res.response?.data?.statuses ?? [])[0] as
        | { resting?: { oid: number } }
        | { filled?: { totalSz: string; avgPx: string; oid: number } }
        | { error?: string }
        | undefined;
      if (status && "error" in status && status.error) {
        return { ok: false, error: { code: "REJECTED", message: status.error }, state: "rejected" };
      }
      if (status && "filled" in status && status.filled) {
        const f = status.filled;
        // The order ack never carries a fee (fills do), so this is the taker estimate. Reconciliation replaces
        // it with the real charged amount via feesFor().
        const feeUsd = Number(sz) * Number(f.avgPx) * (this.o.takerFeeRate ?? 0.000458);
        this.ordCoin.set(String(f.oid), coin);
        return { ok: true, ordId: String(f.oid), contracts: num(f.totalSz), avgPx: num(f.avgPx), feeUsd, ts: this.now() };
      }
      // Resting means the IOC did not cross: it will be cancelled by the venue, so nothing was opened.
      if (status && "resting" in status && status.resting) {
        return { ok: false, error: { code: "UNFILLED", message: "IOC order rested without filling" }, state: "rejected" };
      }
      return { ok: false, error: { code: "NOACK", message: "order returned no status" }, state: "unknown" };
    } catch (err) {
      return { ok: false, error: hlError(err), state: "unknown" };
    }
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    const account = this.o.accounts[bee];
    if (!account) return null;
    try {
      const st = await this.info.clearinghouseState({ user: account });
      return ((st.assetPositions ?? []) as Position[])
        .filter((p) => num(p.position.szi) !== 0)
        .map((p) => ({ instId: p.position.coin, pos: num(p.position.szi), avgPx: num(p.position.entryPx) }));
    } catch (err) {
      log.warn("positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async fundingBills(bee: BeeId): Promise<FundingBill[] | null> {
    const account = this.o.accounts[bee];
    if (!account) return null;
    try {
      // Hyperliquid settles hourly; pull the last day so a restart never misses a settlement.
      const rows = await this.info.userFunding({ user: account, startTime: this.now() - 86_400_000 });
      return rows
        .filter((r) => r.delta?.type === "funding")
        .map((r) => ({
          // Funding rows carry a zero hash and no id: time + coin + amount is the natural key, and the db's
          // insertFunding() dedupes on it.
          billId: `hl-funding-${r.time}-${r.delta.coin}-${r.delta.usdc}`,
          instId: r.delta.coin,
          amountUsd: num(r.delta.usdc),
          ts: r.time,
        }));
    } catch (err) {
      log.warn("funding read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    const account = this.o.accounts[bee];
    if (!account) return null;
    try {
      const out = new Map<string, number>();
      const fills = await this.info.userFillsByTime({ user: account, startTime: this.now() - 86_400_000 });
      for (const f of fills) {
        const oid = String(f.oid);
        if (!ordIds.has(oid)) continue;
        // Hyperliquid reports fee as a positive USDC amount already paid.
        out.set(oid, num(f.fee));
      }
      return out;
    } catch (err) {
      log.warn("fills read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}

/** Wait for a fill to appear for an order id, used by the round-trip tool. */
export async function waitForFill(info: InfoClient, account: string, oid: string, timeoutMs = 15_000): Promise<{ sz: number; px: number; fee: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fills = await info.userFillsByTime({ user: account as `0x${string}`, startTime: Date.now() - 3_600_000 });
    const hit = fills.find((f) => String(f.oid) === oid);
    if (hit) return { sz: num(hit.sz), px: num(hit.px), fee: num(hit.fee) };
    await sleep(400);
  }
  return null;
}
