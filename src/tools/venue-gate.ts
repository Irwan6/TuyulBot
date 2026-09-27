// Show what VENUE would gate right now, from live public data only. No keys, no Jev call, no wallet.
//
//   pnpm venue:gate                # the venue in .env (or OKX by default)
//   VENUE=hyperliquid pnpm venue:gate
//   VENUE=hyperliquid HL_TESTNET=1 pnpm venue:gate   # read the Hyperliquid testnet market
//
// Prints the same gate the engine uses (market/universe.ts), so the numbers are what the bees would actually see:
// how many coins pass the volume and spread gates, which are blocked, and which classify as "unknown" (and are
// therefore never traded until they are added to market/kinds.ts).
import { createVenueFeed } from "../market/venue.js";
import { gateUniverse } from "../market/universe.js";
import { log, setLogLevel } from "../log.js";

const numEnv = (k: string, d: number) => (Number.isFinite(Number(process.env[k])) && process.env[k] ? Number(process.env[k]) : d);
const venueId = (process.env.VENUE as "okx" | "hyperliquid" | undefined) ?? "okx";

setLogLevel("error");

const venue = createVenueFeed({
  venue: venueId,
  okxApiBase: process.env.OKX_API_BASE || "https://eea.okx.com",
  hlMainnetApiBase: process.env.HL_API_BASE || "https://api.hyperliquid.xyz",
  hlTestnetApiBase: process.env.HL_TESTNET_API_BASE || "https://api.hyperliquid-testnet.xyz",
  demo: process.env.HL_TESTNET === "1",
  timeoutMs: 20_000,
  weightBudgetPerMin: numEnv("HL_WEIGHT_BUDGET_PER_MIN", 1200),
});

console.log(`venue: ${venue.label}  (funding ${venue.fundingPerDay}x/day)`);
const t0 = Date.now();
const instruments = await venue.api.instruments();
// Spreads first, or every coin would be held by the spread gate for lack of a measured book.
await venue.api.refreshSpreads?.([]);
const tickers = await venue.api.tickers();
const oi = await venue.api.openInterest();
console.log(`fetched ${instruments.length} instruments, ${tickers.size} tickers, ${oi.size} open-interest rows in ${Date.now() - t0} ms\n`);

const g = gateUniverse(instruments, tickers, {
  min24hVolUsd: numEnv("MIN_24H_VOL_USD", 1_000_000),
  spreadGateBps: numEnv("BOOZY_SPREAD_GATE_BPS", 15),
  allowNonCrypto: process.env.ALLOW_NON_CRYPTO === "true",
  venueFilter: venue.venueFilter,
});

const row = (id: string) => {
  const t = tickers.get(id);
  const kind = instruments.find((i) => i.instId === id)?.kind ?? "?";
  return `${id.padEnd(12)} ${kind.padEnd(9)} vol $${(t?.vol24hUsd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(14)}  spread ${Number.isFinite(t?.spreadBp) ? `${t!.spreadBp.toFixed(3)} bp` : "unmeasured"}`;
};

console.log(`TRADABLE: ${g.tradable.length} of ${instruments.length}`);
console.log(`  gates: >= $${numEnv("MIN_24H_VOL_USD", 1_000_000).toLocaleString("en-US")} 24h volume, spread <= ${numEnv("BOOZY_SPREAD_GATE_BPS", 15)} bp, crypto only (ALLOW_NON_CRYPTO=${process.env.ALLOW_NON_CRYPTO === "true"})\n`);
for (const id of g.tradable.slice(0, 25)) console.log("  " + row(id));
if (g.tradable.length > 25) console.log(`  ... and ${g.tradable.length - 25} more`);

if (g.spreadBlocked.length) {
  console.log(`\nSPREAD-BLOCKED (${g.spreadBlocked.length}): liquid enough, too wide to trade`);
  for (const id of g.spreadBlocked.slice(0, 10)) console.log("  " + row(id));
}
if (g.unknown.length) {
  console.log(`\nUNKNOWN (${g.unknown.length}): not classified in market/kinds.ts, so never traded`);
  console.log("  " + g.unknown.slice(0, 30).join(", "));
  console.log("  Add the ones you want to trade to kinds.ts (CRYPTO or HL_NATIVE).");
}
log.info("venue gate report done");
