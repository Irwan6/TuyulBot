// Phase 7 smoke test on Hyperliquid TESTNET (fake money): one minimum-size round trip per bee.
// Uses the engine's own HyperliquidExecutor — the code the bees will run — not a copy of it.
//
//   VENUE=hyperliquid MODE=demo pnpm hl:roundtrip [COIN=BTC]
//
// Needs, in .env:
//   BEE1_HL_AGENT_KEY / BEE1_HL_ACCOUNT   (and BEE2_*, BEE3_*)
// The agent key is the API wallet you approved in the Hyperliquid UI. It can trade and cannot withdraw.
// This tool refuses to run against mainnet, and it always closes what it opens.
import { BEES, type BeeId } from "../config.js";
import { HyperliquidExecutor, formatSz } from "../exec/hyperliquid.js";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

const COIN = (process.argv[2] ?? "BTC").toUpperCase();
const env = process.env;
const TESTNET = env.HL_TESTNET_API_BASE ?? "https://api.hyperliquid-testnet.xyz";

// MODE=demo means the Hyperliquid TESTNET (with DRY_RUN=false), which is exactly what this tool is for.
// Only MODE=live moves real money, so that is the one combination to refuse. The transport below is hardcoded
// to testnet as a second line of defence: this tool can never reach mainnet even if the env is wrong.
if (env.MODE === "live") {
  throw new Error("refusing to run: MODE=live moves real money. This tool is testnet-only (use MODE=demo).");
}

const agentKeys: Partial<Record<BeeId, `0x${string}`>> = {};
const accounts: Partial<Record<BeeId, `0x${string}`>> = {};
const missing: string[] = [];
for (const b of BEES) {
  const p = b.toUpperCase();
  const k = env[`${p}_HL_AGENT_KEY`] as `0x${string}` | undefined;
  const a = env[`${p}_HL_ACCOUNT`] as `0x${string}` | undefined;
  if (!k || !a) {
    missing.push(`${p}_HL_AGENT_KEY / ${p}_HL_ACCOUNT`);
    continue;
  }
  agentKeys[b] = k;
  accounts[b] = a;
}
if (missing.length) {
  throw new Error(
    `missing Hyperliquid credentials:\n  ${missing.join("\n  ")}\n\n` +
      `Create an API (agent) wallet in the Hyperliquid UI, then put its private key and your main wallet\n` +
      `address in .env. The agent key can trade and cannot withdraw; your main key never leaves MetaMask.`,
  );
}

const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const meta = await info.meta();
const universe = meta.universe;
const idx = new Map(universe.map((u, i) => [u.name, i]));
const u = universe[idx.get(COIN)!];
if (!u) throw new Error(`testnet has no perp named ${COIN}`);

const mids = await info.allMids();
const mid = Number(mids[COIN]);
if (!(mid > 0)) throw new Error(`no mid price for ${COIN} on testnet`);

const inst = {
  instId: COIN,
  coin: COIN,
  kind: "crypto" as const,
  ctVal: 1,
  lotSz: 10 ** -u.szDecimals,
  minSz: 10 ** -u.szDecimals,
  // Hyperliquid's price tick: 5 significant figures, capped at 6 - szDecimals decimals.
  tickSz: 10 ** -Math.max(0, 6 - u.szDecimals),
  state: "live",
};
// Hyperliquid's own floor is a $10 notional, so the smallest legal order is that, not one lot.
const minSzFor10Usd = Math.ceil(10 / mid / inst.lotSz) * inst.lotSz;
const sz = formatSz(minSzFor10Usd, inst.lotSz);

console.log(`testnet ${COIN}: mid ${mid} · szDecimals ${u.szDecimals} · lot ${inst.lotSz}`);
console.log(`smallest legal order: ${sz} ${COIN} ≈ $${(Number(sz) * mid).toFixed(2)} (Hyperliquid minimum is $10)\n`);

const exec = new HyperliquidExecutor({
  agentKeys,
  accounts,
  testnet: true,
  leverage: 2,
  slippageBps: 50,
  minNotionalUsd: 10,
  instrument: (id) => (id === COIN ? inst : undefined),
  midFor: (id) => (id === COIN ? mid : undefined),
});

let problems = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) problems++;
};

for (const bee of BEES) {
  console.log(`— ${bee}`);
  try {
    await exec.init(bee);
    const agent = privateKeyToAccount(agentKeys[bee]!);
    console.log(`   agent ${agent.address} signs for ${accounts[bee]}`);

    // An approved agent does NOT necessarily show up in extraAgents: only NAMED agents are listed there, and
    // an unnamed one comes back as an empty array. `userRole` is the authoritative check — it answers "is this
    // address an agent, and if so, for which account". Checking extraAgents alone would reject a valid key.
    try {
      const role = await info.userRole({ user: agent.address });
      const actsFor = role.role === "agent" ? (role.data as { user: string }).user.toLowerCase() : "";
      const matches = actsFor === accounts[bee]!.toLowerCase();
      ok(matches, matches ? `agent is approved for ${accounts[bee]}` : `agent is NOT approved for this account (userRole = ${JSON.stringify(role).slice(0, 120)})`);
      if (!matches) continue;

      const agents = (await info.extraAgents({ user: accounts[bee]! })) as unknown as Array<{ address?: string; name?: string; validUntil?: number }>;
      const named = agents.find((a) => a.address?.toLowerCase() === agent.address.toLowerCase());
      if (named?.validUntil) {
        const days = Math.round((named.validUntil - Date.now()) / 86_400_000);
        console.log(`   named agent "${named.name}" · expires in ${days} day(s)`);
      }
    } catch (e) {
      console.log(`   ? could not read userRole (${String((e as Error).message).slice(0, 60)}); continuing`);
    }

    const before = (await info.clearinghouseState({ user: accounts[bee]! })).assetPositions.find((p) => p.position.coin === COIN);
    if (before && Number(before.position.szi) !== 0) {
      console.log(`   already holds ${before.position.szi} ${COIN}; skipping this bee so nothing is disturbed`);
      problems++;
      continue;
    }

    // Must be rejected: reduce-only while flat. Proves the guard runs before the order is signed.
    const guard = await exec.market(bee, { instId: COIN, side: "sell", contracts: Number(sz), reduceOnly: true, clOrdId: `g${Date.now().toString(36)}` });
    ok(!guard.ok, `reduce-only while flat is rejected${guard.ok ? " (IT FILLED: STOP)" : ` (${guard.error.code})`}`);

    // Must be rejected: below the $10 minimum notional, caught here instead of by the venue.
    const tiny = await exec.market(bee, { instId: COIN, side: "buy", contracts: inst.lotSz / 100, reduceOnly: false, clOrdId: `t${Date.now().toString(36)}` });
    ok(!tiny.ok, `sub-minimum notional is rejected locally (${tiny.ok ? "IT WAS ACCEPTED" : tiny.error.code})`);

    const open = await exec.market(bee, { instId: COIN, side: "buy", contracts: Number(sz), reduceOnly: false, clOrdId: `o${Date.now().toString(36)}` });
    if (!open.ok) {
      ok(false, `open failed: ${open.error.code} ${open.error.message}`);
      continue;
    }
    console.log(`   open filled ${open.contracts} ${COIN} @ ${open.avgPx} (fee est $${open.feeUsd.toFixed(4)})`);

    // The position must now be visible on the venue, read back from the account, not from our own state.
    const held = (await info.clearinghouseState({ user: accounts[bee]! })).assetPositions.find((p) => p.position.coin === COIN);
    ok(Number(held?.position.szi ?? 0) > 0, `venue confirms position ${held?.position.szi ?? 0} ${COIN}`);

    const close = await exec.market(bee, { instId: COIN, side: "sell", contracts: Number(sz), reduceOnly: true, clOrdId: `c${Date.now().toString(36)}` });
    if (!close.ok) {
      ok(false, `close failed: ${close.error.code} ${close.error.message}`);
      continue;
    }
    console.log(`   close filled ${close.contracts} ${COIN} @ ${close.avgPx}`);

    // Real fee from the venue's own fill record, which is what reconciliation uses.
    if (open.ordId) {
      const fees = (await exec.feesFor(bee, [COIN], new Set([open.ordId]))) ?? new Map<string, number>();
      const real = fees.get(open.ordId);
      ok(real !== undefined, `venue reported the real fee for order ${open.ordId}: $${(real ?? 0).toFixed(5)}`);
    } else {
      ok(false, "order ack had no order id, so the fee could not be reconciled");
    }

    const flat = (await info.clearinghouseState({ user: accounts[bee]! })).assetPositions.find((p) => p.position.coin === COIN);
    ok(Number(flat?.position.szi ?? 0) === 0, `flat again (${flat?.position.szi ?? 0} ${COIN})`);
  } catch (e) {
    ok(false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

console.log(`\n${problems === 0 ? "PASS" : `FAIL: ${problems} problem(s)`} · testnet ${TESTNET}`);
process.exit(problems === 0 ? 0 : 1);
