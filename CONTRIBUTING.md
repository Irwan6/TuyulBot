# Working on this fork

This repository is a fork of [imikerussell/beebots](https://github.com/imikerussell/beebots) that adds a
Hyperliquid venue. `origin` is the fork, `upstream` is the original.

```sh
git remote -v            # origin = Irwan6/TuyulBot, upstream = imikerussell/beebots
```

## The gate before any push

CI (`.github/workflows/images.yml`) runs this on Linux, so all three must pass locally first:

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm lint` bans `console` outside `src/tools/**`: all output goes through the redacting logger in
`src/log.ts`, because a key or an IP address printed to a log is a leak. Tools under `src/tools/` are exempt
and print for a human.

Two tests fail on Windows by design: `test/hive.test.ts` and `test/setup.test.ts` assert POSIX file modes
(`0o600`), which NTFS cannot represent. They pass on Linux and in CI. Do not "fix" them by loosening the
assertion — the assertion is the security property.

## Pulling in upstream changes

The fork and upstream both move. Check before starting work:

```sh
git fetch upstream
git log --oneline HEAD..upstream/main     # upstream commits you do not have
git log --oneline upstream..HEAD          # your commits upstream does not have
```

To take an upstream release:

```sh
git fetch upstream
git merge upstream/main
```

Expect conflicts in `README.md` and `src/config.ts`, the two files both sides edit most. Resolve by keeping
both: upstream's new settings belong in `config.ts` alongside `VENUE` and the `BEE<n>_HL_*` credentials.

Upstream also changes trading behaviour, not just plumbing — a release can alter when orders are sent or how
size is chosen. Read `git log -p upstream/main..HEAD` before merging rather than trusting that it is additive.

## Running against each venue

```sh
VENUE=okx pnpm e2e:fake-jev          # OKX paper, fake Jev, no keys
VENUE=hyperliquid pnpm e2e:hl        # Hyperliquid paper, fake Jev, no keys, no wallet
VENUE=hyperliquid pnpm venue:gate    # what the gate would trade right now
```

Everything below reads only; none of it moves money.

| command | answers |
|---|---|
| `pnpm hl:account 0x…` | is this address an account or an agent, on mainnet **and** testnet |
| `pnpm hl:arb 0x…` | which of Arbitrum's two USDCs is at this address |
| `pnpm hl:roundtrip` | one real testnet round trip per bee (needs an approved agent wallet) |
| `pnpm keycheck` | are the configured OKX keys valid, read-only |

## Credentials

`.env` is git-ignored; `.env.example` documents every setting. Never commit a key, an address you trade
from, or a `.sqlite` file (`data/` is ignored too).

For Hyperliquid the engine holds only an **agent (API) wallet** key, which can trade and cannot withdraw.
The main wallet's private key is never needed. Keep it that way: if a change seems to require the main key,
the change is wrong.
