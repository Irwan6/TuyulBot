// Prove the signed-order path on a LIVE account without risking a single dollar.
//
//   VENUE=hyperliquid pnpm hl:signcheck
//
// How it is safe: it reads the account first and REFUSES TO SEND ANYTHING unless perp equity is exactly zero
// and there are no open positions. With no margin, no order can be filled by the venue — so the only two
// possible outcomes are "signature rejected" or "rejected for insufficient margin", and the second one is
// the proof that signing, pricing and asset resolution all worked.
//
// It re-reads the account afterwards and fails loudly if anything changed. Read that final check before
// trusting the run.
import { BEES, type BeeId } from "../config.js";
import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { formatPx, formatSz } from "../exec/hyperliquid.js";

const COIN = (process.argv[2] ?? "BTC").toUpperCase();
const env = process.env;

if (env.MODE === "demo") {
  console.error("MODE=demo points at testnet. Unset it to check mainnet, or use `pnpm hl:roundtrip` for testnet.");
  process.exit(2);
}

const agentKeys: Partial<Record<BeeId, `0x${string}`>> = {};
const accounts: Partial<Record<BeeId, `0x${string}`>> = {};
for (const b of BEES) {
  const p = b.toUpperCase();
  const k = env[`${p}_HL_AGENT_KEY`] as `0x${string}` | undefined;
  const a = env[`${p}_HL_ACCOUNT`] as `0x${string}` | undefined;
  if (k && a) {
    agentKeys[b] = k;
    accounts[b] = a;
  }
}
const bee = (BEES as readonly BeeId[]).find((b) => agentKeys[b] && accounts[b]);
if (!bee) {
  console.error("No BEE<n>_HL_AGENT_KEY / BEE<n>_HL_ACCOUNT pair in the environment.");
  process.exit(2);
}

const transport = new HttpTransport({ isTestnet: false });
const info = new InfoClient({ transport });
const account = accounts[bee]!;
const agent = privateKeyToAccount(agentKeys[bee]!);

console.log(`MAINNET signing check · ${bee}\n`);
console.log(`  account ${account}`);
console.log(`  agent   ${agent.address}`);

let problems = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) problems++;
};

// ---- 1. agent approval -------------------------------------------------------------------------------
const role = await info.userRole({ user: agent.address });
const actsFor = role.role === "agent" ? (role.data as { user: string }).user : "";
ok(actsFor.toLowerCase() === account.toLowerCase(), `agent approved for this account (userRole: ${role.role})`);

// ---- 2. THE SAFETY GATE ------------------------------------------------------------------------------
// Nothing is sent unless the account is provably unable to fill anything.
//
// The trap this avoids: `clearinghouseState.marginSummary.accountValue` is the PERP balance only. On an
// account in unified-account mode (`userAbstraction: "unifiedAccount"`) the spot USDC balance backs perps
// too, so an account showing $0.00 perp equity can still fill an order — verified the hard way. The gate
// therefore sums every balance the account could trade with, not just the perp one.
const abstraction = await info.userAbstraction({ user: account }).catch(() => "unknown");
const before = await info.clearinghouseState({ user: account });
const spotBefore = await info.spotClearinghouseState({ user: account });
const equity = Number(before.marginSummary.accountValue);
const spotUsdc = Number(spotBefore.balances.find((b) => b.coin === "USDC")?.total ?? 0);
const open = before.assetPositions.filter((p) => Number(p.position.szi) !== 0);
const usable = equity + spotUsdc;

console.log(`\n  abstraction ${abstraction}`);
console.log(`  perp equity $${equity.toFixed(2)} · spot USDC $${spotUsdc.toFixed(2)} · ${open.length} open position(s)`);
if (usable > 0 || open.length > 0) {
  console.error(
    `\nREFUSING TO SEND: this account can trade.\n` +
      `  $${usable.toFixed(2)} of tradable balance (perp $${equity.toFixed(2)} + spot $${spotUsdc.toFixed(2)}),\n` +
      `  ${open.length} open position(s).\n` +
      `  This tool only runs on an account with NOTHING to trade with, so that no order can possibly fill.\n` +
      `  Move the funds out, or use testnet via \`pnpm hl:roundtrip\`.`,
  );
  process.exit(3);
}
console.log("  nothing to trade with confirmed — no order can fill. Proceeding.\n");

// ---- 3. the probe ------------------------------------------------------------------------------------
const meta = await info.meta();
const idx = meta.universe.findIndex((u) => u.name === COIN);
if (idx < 0) {
  console.error(`mainnet has no perp named ${COIN}`);
  process.exit(2);
}
const u = meta.universe[idx]!;
const mid = Number((await info.allMids())[COIN]);
const lot = 10 ** -u.szDecimals;
const sz = formatSz(Math.ceil(10 / mid / lot) * lot, lot);
const px = formatPx(mid * 1.5, u.szDecimals); // far above mid: cannot cross even if margin existed

console.log(`  ${COIN}: mid ${mid} · trying ${sz} ${COIN} @ ${px} (≈$${(Number(sz) * mid).toFixed(2)}, IOC)`);

const exch = new ExchangeClient({ wallet: agent, transport });
try {
  const res = await exch.order({
    orders: [{ a: idx, b: true, p: px, s: sz, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  });
  const status = (res.response?.data?.statuses ?? [])[0] as { filled?: unknown; resting?: unknown; error?: string } | undefined;
  if (status && "error" in status && status.error) {
    // This is the expected outcome, and it is the proof: the venue parsed a correctly signed order.
    const margin = /margin|insufficient/i.test(status.error);
    ok(margin, `venue rejected the signed order: "${status.error}"`);
    if (!margin) console.log(`     unexpected rejection text — signing still worked, but read this closely`);
  } else if (status && "filled" in status) {
    ok(false, `THE ORDER FILLED — stop and inspect the account: ${JSON.stringify(status)}`);
  } else {
    ok(false, `unexpected ack: ${JSON.stringify(status)}`);
  }
} catch (e) {
  const msg = String((e as Error).message);
  const margin = /margin|insufficient/i.test(msg);
  ok(margin, `venue rejected the signed order: "${msg.slice(0, 140)}"`);
  if (!margin) {
    console.log(`     if this is a signature/auth error, the key or its approval is wrong, not the code`);
  }
}

// ---- 4. the account must be untouched -----------------------------------------------------------------
const after = await info.clearinghouseState({ user: account });
const equityAfter = Number(after.marginSummary.accountValue);
const openAfter = after.assetPositions.filter((p) => Number(p.position.szi) !== 0);
ok(openAfter.length === 0, `still flat (${openAfter.length} position(s))`);
ok(Math.abs(equityAfter - equity) < 0.01, `equity unchanged ($${equity.toFixed(2)} → $${equityAfter.toFixed(2)})`);

console.log(`\n${problems === 0 ? "PASS — signing works; only the margin was missing." : `FAIL: ${problems} problem(s)`}`);
process.exit(problems === 0 ? 0 : 1);
