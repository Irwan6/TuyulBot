# Hyperliquid testnet: practise with free money

Testnet is Hyperliquid's rehearsal network. Prices are real, the order book is real, the API is the same — only
the money is fake. Every code path the bot uses gets exercised, and nothing of value is at risk.

Do this before `MODE=live`. The mainnet signing path has already been proven once on a real account, so the
remaining unknowns are all about configuration, and testnet is the cheap place to find them.

## What you need

| | |
|---|---|
| An EVM wallet you control | MetaMask or Rabby |
| A prior mainnet deposit | the faucet requires it — see the trap below |
| ~10 minutes | most of it waiting for the drip |

## The trap: an email login has two different addresses

If your Hyperliquid account is an email login (Privy), **Privy generates a different wallet address for testnet
than for mainnet**. The faucet requires "deposited on mainnet with the same address", so logging in with the same
email on testnet does **not** satisfy it.

The documented fix is to export the mainnet wallet and use it on both networks:

> 1. Make sure you are logged in with the same email address
> 2. Click "Export Email Wallet" in the settings dropdown in the navigation bar
> 3. Follow the steps in the pop-up to copy your private key
> 4. Import your private key into the wallet extension of your choice
>
> — Hyperliquid docs, "Export your email wallet"

That imported wallet has the **same address** as your mainnet account, so the faucet's rule is met.

> **The exported key is your real wallet key.** It can withdraw. Import it into MetaMask and keep it there.
> It must never go into `.env` and must never be sent to anyone — not to beebots, not to any tool. Only the
> **agent (API) wallet** key goes into `.env`, and that one cannot withdraw.

## Step by step

### 1. Export your email wallet (skip if you use MetaMask already)

Logged in at `app.hyperliquid.xyz` with your email → **settings dropdown** (top right) → **Export Email Wallet**
→ copy the private key.

### 2. Import it into MetaMask

MetaMask → account menu → **Import account** → paste that private key. You now have a MetaMask account with the
same address as your Hyperliquid account. Verify the address matches your mainnet account before continuing.

### 3. Connect that wallet to testnet

Open `app.hyperliquid-testnet.xyz` → **Connect** → the imported MetaMask account.

The address shown must be the **same** one that made the mainnet deposit. If it differs, the faucet will refuse.

### 4. Claim the drip

Go to `https://app.hyperliquid-testnet.xyz/drip` and click **Claim 1000 mock USDC**.

Mock USDC has no value, cannot be withdrawn and cannot be moved to mainnet. It exists only to be traded on
testnet. The docs say "once"; some guides say every 4 hours. Treat it as once.

### 5. Create a testnet agent wallet

An agent approved on mainnet is `role: "missing"` on testnet — approvals do not carry over, so you need a
second one.

On `app.hyperliquid-testnet.xyz/API`:

1. Name it (e.g. `tuyul-testnet`)
2. **Generate** → the dialog shows **Address** *and* **Private Key**
3. **Copy the private key now** — `0x` + 64 hex characters. It is shown once and cannot be displayed again.
4. **Authorize API Wallet**

The address is `0x` + 40 hex; the private key is `0x` + 64 hex. If what you copied is 42 characters long, it is
the address, not the key.

### 6. Point the bot at testnet

In `.env`:

```bash
VENUE=hyperliquid
DRY_RUN=false
MODE=demo

# The testnet agent key from step 5, and your account address (the one that dripped).
BEE1_HL_AGENT_KEY=0x...        # 64 hex, from the testnet /API page
BEE1_HL_ACCOUNT=0x...          # your account address
# BEE2_* and BEE3_* can reuse the same pair; one agent may sign for all three.
```

`MODE=demo` is what selects the testnet. `DRY_RUN=false` is what allows real orders to be sent — to the
**testnet**, where they cost nothing. With `DRY_RUN=true` the engine uses the simulator and never sends anything,
which is not what you want here.

`BEE_START_EQUITY_USD=300` gives the three bees $900 of the 1,000 mock USDC, leaving headroom.

### 7. Check the setup

```bash
pnpm hl:account 0xYourAccountAddress     # both networks; testnet should show the mock USDC
VENUE=hyperliquid MODE=demo pnpm hl:roundtrip
```

`hl:roundtrip` opens a real position with each bee, reads it back from the venue, closes it, and reconciles the
real fee. It must end with `PASS`.

### 8. Run the engine

```bash
VENUE=hyperliquid MODE=demo pnpm e2e:hl      # fake Jev, no spend, real testnet data
```

For the dashboard, in a second terminal:

```bash
cd dashboard && ENGINE_URL=http://127.0.0.1:18081 pnpm dev
```

Then open `http://127.0.0.1:5173`.

## What testnet does not cover

Being honest about the gaps, because each one is a mainnet-only surprise:

- **Fills are easier.** A testnet book is thin, so slippage and partial fills behave differently from mainnet.
- **Funding is not real money.** It accrues, but nobody pays it.
- **Minimums still apply.** The $10 minimum notional and the per-coin lot sizes are the same as mainnet, so a
  coin that cannot be traded on mainnet (ZEC, whose minimum lot is ~$16.55) cannot be traded here either.
- **Rate limits are separate.** Testnet has its own weight budget, so a 429 there does not predict one on mainnet.

## Checklist

- [ ] Mainnet deposit exists from the address you will use
- [ ] The same address connects on `app.hyperliquid-testnet.xyz`
- [ ] Drip claimed, `pnpm hl:account` shows mock USDC on testnet
- [ ] Testnet agent created **and authorized** on testnet
- [ ] `BEE<n>_HL_AGENT_KEY` is the testnet agent's **private key** (66 chars), not its address
- [ ] `BEE<n>_HL_ACCOUNT` is your **account** address, not the agent's
- [ ] `pnpm hl:roundtrip` ends with `PASS`
- [ ] `.env` is git-ignored (it is, by default) and no key was pasted anywhere else
