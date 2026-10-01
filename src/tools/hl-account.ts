// Read-only: what does Hyperliquid know about an address? No key, no orders.
//
//   pnpm hl:account 0xYourAddress        # check one address on BOTH networks (mainnet + testnet)
//   pnpm hl:account --mainnet 0xAddress  # one network only
//   pnpm hl:account                      # every BEE<n>_HL_ACCOUNT in .env
//
// Both networks by default, because the answer that matters is often "which address actually holds the mock
// USDC": an email/Privy login gets a DIFFERENT address on testnet than on mainnet, and the faucet requires a
// mainnet deposit from the same address.
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BEES } from "../config.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const only = process.argv.includes("--mainnet") ? "mainnet" : process.argv.includes("--testnet") ? "testnet" : "";

// Several addresses at once, so a MetaMask address and an email-login address can be compared side by side —
// which is the whole question when the testnet address may differ from the mainnet one.
const targets: Array<{ label: string; address: string }> = args.length
  ? args.map((a, i) => ({ label: args.length === 1 ? "argument" : `address ${i + 1}`, address: a }))
  : [];
if (!targets.length) {
  for (const bee of BEES) {
    const a = process.env[`${bee.toUpperCase()}_HL_ACCOUNT`];
    if (a) targets.push({ label: bee, address: a });
  }
}
if (!targets.length) {
  console.error("No address given. Pass one, or set BEE<n>_HL_ACCOUNT in .env.\n  pnpm hl:account 0xYourMainWalletAddress");
  process.exit(2);
}

const isAddr = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

let problems = 0;
const networks: Array<{ name: string; testnet: boolean }> = only
  ? [{ name: only.toUpperCase(), testnet: only === "testnet" }]
  : [
      { name: "MAINNET", testnet: false },
      { name: "TESTNET", testnet: true },
    ];

for (const { label, address } of targets) {
  console.log(`\n═══ ${label}: ${address} ═══`);
  if (!isAddr(address)) {
    console.log(`   ✗ not a valid address: needs 0x + 40 hex characters${address.startsWith("HL:") ? " (drop the HL: prefix)" : ""}`);
    problems++;
    continue;
  }
  if (address.toLowerCase().startsWith("0x0000000000")) {
    console.log("   ✗ zero address");
    problems++;
    continue;
  }

  // Findings per network, so the two can be compared at the end — that comparison is the point of this tool.
  const found: Array<{ net: string; role: string; perp: number; usdc: number }> = [];

  for (const net of networks) {
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet: net.testnet }) });
    console.log(`\n— ${net.name}`);
    try {
      const role = await info.userRole({ user: address });
      const st = await info.clearinghouseState({ user: address });
      const spot = await info.spotClearinghouseState({ user: address });
      const perpValue = Number(st.marginSummary.accountValue);
      const positions = st.assetPositions.filter((p) => Number(p.position.szi) !== 0);
      const usdc = spot.balances.find((b) => b.coin === "USDC");
      const usdcTotal = usdc ? Number(usdc.total) : 0;
      found.push({ net: net.name, role: role.role, perp: perpValue, usdc: usdcTotal });

      console.log(`   role         ${role.role}`);
      console.log(`   perp equity  $${perpValue.toFixed(2)}${positions.length ? ` · ${positions.length} open position(s)` : ""}`);
      console.log(`   spot USDC    ${usdcTotal.toFixed(2)}`);

      // An agent address is a signer, not an account: reading positions from it returns empty forever.
      if (role.role === "agent") {
        const actsFor = (role.data as { user: string }).user as `0x${string}`;
        console.log(`   ✗ THIS IS AN AGENT (API) WALLET, not an account. It signs for ${actsFor}.`);
        console.log(`     Use ${actsFor} as BEE<n>_HL_ACCOUNT, and this address only as BEE<n>_HL_AGENT_KEY.`);
        // Read the account it acts for, so the account's own state is visible from here too — that is
        // usually the next question ("so does the account have funds?").
        try {
          const acctSt = await info.clearinghouseState({ user: actsFor });
          const acctSpot = await info.spotClearinghouseState({ user: actsFor });
          const acctUsdc = acctSpot.balances.find((b) => b.coin === "USDC");
          console.log(`     that account: $${Number(acctSt.marginSummary.accountValue).toFixed(2)} perp equity, ${acctUsdc ? Number(acctUsdc.total).toFixed(2) : "0"} USDC spot`);
          const ag = (await info.extraAgents({ user: actsFor })) as unknown as Array<{ address?: string; name?: string; validUntil?: number }>;
          const self = ag.find((a) => a.address?.toLowerCase() === address.toLowerCase());
          if (self) {
            const days = self.validUntil ? Math.round((self.validUntil - Date.now()) / 86_400_000) : null;
            console.log(`     registered as ${self.name ? `"${self.name}"` : "(unnamed)"}${days !== null ? ` · expires in ${days} day(s)` : ""}`);
          } else {
            console.log(`     not in extraAgents: either unnamed (still valid) or NOT approved for this account`);
          }
        } catch {
          /* advisory only */
        }
        problems++;
        continue;
      }
      if (role.role === "vault" || role.role === "subAccount") {
        console.log(`   ! role is "${role.role}": beebots reads and trades the main account, so this is not a drop-in BEE<n>_HL_ACCOUNT`);
        problems++;
        continue;
      }

      const agents = (await info.extraAgents({ user: address })) as unknown as Array<{
        address?: string;
        name?: string;
        validUntil?: number;
      }>;
      for (const a of agents) {
        const days = a.validUntil ? Math.round((a.validUntil - Date.now()) / 86_400_000) : null;
        console.log(`   agent        ${a.address}${a.name ? ` "${a.name}"` : ""}${days !== null ? ` · expires in ${days}d` : ""}`);
      }
      if (!agents.length) {
        // Not an error: unnamed agents are valid and never appear in this list (see userRole for the truth).
        console.log("   agent        none named (an unnamed approved agent is still valid and will not show here)");
      }

      if (role.role === "missing" && perpValue === 0 && usdcTotal === 0) {
        console.log(`   · Hyperliquid has never seen this address on ${net.name.toLowerCase()}`);
        if (!net.testnet) console.log("     (the faucet needs a mainnet deposit from the SAME address, so this address cannot drip yet)");
      } else {
        console.log(`   ✓ live on ${net.name.toLowerCase()}${usdcTotal > 0 ? ` with $${usdcTotal.toFixed(2)}${net.testnet ? " mock" : ""} USDC` : ""}`);
      }
    } catch (e) {
      console.log(`   ✗ lookup failed: ${String((e as Error).message).slice(0, 160)}`);
      problems++;
    }
  }

  // The comparison that catches the email-login trap: two different addresses, so the faucet's
  // "deposited on mainnet with the same address" requirement is not met by construction.
  if (found.length === 2) {
    const [m, t] = found as [(typeof found)[number], (typeof found)[number]];
    console.log(`\n   ── comparison ──`);
    if (m.role === "missing" && t.role !== "missing") {
      console.log(`   ! you have testnet state but no mainnet state on THIS address.`);
    } else if (m.role !== "missing" && t.role === "missing") {
      console.log(`   ! mainnet is live but testnet is not: connect the SAME wallet to app.hyperliquid-testnet.xyz`);
      console.log(`     and claim at /drip. An email login gives a DIFFERENT address on testnet, so the`);
      console.log(`     faucet's "same address" rule is not satisfied — use an imported wallet instead.`);
    } else if (m.role === "missing" && t.role === "missing") {
      console.log(`   · unseen on both networks. If you deposited, the address is not the one you deposited from.`);
    } else {
      console.log(`   ✓ live on both networks`);
    }
  }
}

console.log(problems === 0 ? "\nAll good." : `\n${problems} address(es) need attention.`);
