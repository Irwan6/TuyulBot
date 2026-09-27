// What is actually sitting at an address on Arbitrum One? No key, read-only.
//
//   pnpm hl:arb 0xSomeAddress
//
// The reason this exists: Arbitrum has TWO tokens that both call themselves "USDC" and both show as
// "USD Coin" in a block explorer, but Hyperliquid only credits the native one.
//
//   native USDC   0xaf88d065e77c8cC2239327C5EDb3A432268e5831   name() = "USD Coin"
//   bridged USDC.e 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8  name() = "USD Coin (Arb1)"
//
// Use it to confirm a deposit landed, and in which token — a CEX that shows "ARBUSDCE" separately from "USDC"
// means the plain USDC entry is the native one, and that is the one Hyperliquid sends.
import { createPublicClient, http, formatUnits, formatEther, getAddress } from "viem";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: pnpm hl:arb 0xAddress");
  process.exit(2);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
  console.error(`not a valid address: ${raw}${raw.startsWith("HL:") ? " (drop the HL: prefix)" : ""}`);
  process.exit(2);
}
const address = getAddress(raw);

const arb = createPublicClient({ transport: http("https://arb1.arbitrum.io/rpc", { timeout: 20_000 }) });
const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const TOKENS: Array<{ label: string; address: `0x${string}`; note: string }> = [
  {
    label: "native USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    note: "this is the one Hyperliquid credits and sends",
  },
  {
    label: "bridged USDC.e",
    address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    note: "legacy; NOT a Hyperliquid deposit route",
  },
];

console.log(`Arbitrum One — ${address}\n`);

const eth = await arb.getBalance({ address });
console.log(`  ETH (gas)      ${formatEther(eth)} ETH${eth === 0n ? "   (empty — needed to move funds out)" : ""}`);

let anyUsdc = false;
for (const t of TOKENS) {
  try {
    const bal = await arb.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [address] });
    const n = Number(formatUnits(bal, 6));
    if (n > 0) anyUsdc = true;
    console.log(`  ${t.label.padEnd(14)} ${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC${n > 0 ? `   ← ${t.note}` : ""}`);
  } catch (e) {
    console.log(`  ${t.label.padEnd(14)} read failed: ${String((e as Error).message).slice(0, 70)}`);
  }
}

const nonce = await arb.getTransactionCount({ address });
console.log(`  transactions   ${nonce}${nonce === 0 ? "   (this address has never been used on Arbitrum)" : ""}`);
if (!anyUsdc && nonce === 0) {
  console.log(`\n  nothing here yet. A Hyperliquid withdrawal sends native USDC to Arbitrum One and costs $1.`);
}
