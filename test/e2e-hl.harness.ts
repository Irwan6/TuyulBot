// Dry end-to-end harness on HYPERLIQUID data with a FAKE Jev (random picks). No keys, no Jev spend, no wallet.
// This is the VENUE=hyperliquid twin of test/e2e-dry.harness.ts, used to prove the engine actually runs against
// real Hyperliquid market data (see docs in src/hyperliquid/public.ts for why that venue).
//
//   pnpm e2e:hl                       # runs until Ctrl-C
//   E2E_SECONDS=60 pnpm e2e:hl        # stop after 60 s
//   E2E_TESTNET=1 pnpm e2e:hl         # read the Hyperliquid testnet market instead of mainnet
import { Alerts } from "../src/alerts.js";
import { BREEZY_COINS } from "../src/bees/breezy.js";
import { BEES, loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { log } from "../src/log.js";
import { MarketFeed } from "../src/market/data.js";
import { createVenueFeed } from "../src/market/venue.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

const fakeJev: SystemOne = {
  async systemOne(req) {
    const labels = Object.keys((req.questions.action as { criteria: object }).criteria);
    const w = labels.map(() => Math.random());
    const sum = w.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(labels.map((l, i) => [l, w[i]! / sum]));
    const choice = labels[w.indexOf(Math.max(...w))]!;
    await new Promise((r) => setTimeout(r, 50));
    return { model: "fake", usage: { input_tokens: 600, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: probabilities[choice], probabilities }, conviction: { type: "score", score: Math.random() * 3, confidence: 0.5, legend: {}, probabilities: {} } } } as never;
  },
};

const cfg = loadConfig({
  TYPESAFE_API_KEY: "fake",
  DRY_RUN: "true",
  VENUE: "hyperliquid",
  TICK_MS: "2000",
  DATA_REFRESH_MS: "20000",
  DB_PATH: process.env.E2E_DB ?? "./data/e2e-hl.sqlite",
  ENGINE_PORT: process.env.E2E_PORT ?? "18081",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
});

const db = new Db(cfg.dbPath);
const bus = new EventBus(db);
const venue = createVenueFeed({
  venue: cfg.venue,
  okxApiBase: cfg.okx.apiBase,
  hlMainnetApiBase: cfg.hl.mainnetApiBase,
  hlTestnetApiBase: cfg.hl.testnetApiBase,
  demo: process.env.E2E_TESTNET === "1",
  timeoutMs: 15_000,
  weightBudgetPerMin: cfg.hl.weightBudgetPerMin,
});

const feed = new MarketFeed(
  venue.api,
  {
    min24hVolUsd: cfg.universe.min24hVolUsd,
    allowNonCrypto: false,
    spreadGateBps: 15,
    trendCoins: [...BREEZY_COINS],
    venueFilter: venue.venueFilter,
    fundingPerDay: venue.fundingPerDay,
    maxStatCoins: cfg.maxStatCoins,
  },
  null,
  () => BEES.map((b) => engine.bees[b]?.position?.instId).filter((x): x is string => !!x),
);

const exec = new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate);
const jev = new Jev({ ...cfg.jev, client: fakeJev });
const engine: Engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined) });
await engine.start();

const server = startServer(
  { engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine.snapshot(), health: () => engine.health() }, profile: () => ({ bees: [] }), beeImage: () => null },
  cfg.server.port,
  cfg.server.bind,
);

log.info("harness started", { venue: venue.label, fundingPerDay: venue.fundingPerDay, dashboard: `http://127.0.0.1:${cfg.server.port}` });

const report = () => {
  const v = feed.view();
  log.info("gate report", {
    tradable: v.gated.length,
    spreadBlocked: v.spreadBlocked.length,
    instruments: v.instruments.size,
    top12: v.gated.slice(0, 12).join(","),
  });
  for (const id of BEES) {
    const b = engine.bees[id];
    const s = cfg.slots[id];
    log.info("bee", {
      id,
      style: s.style,
      equityUsd: Number(b.equityUsd.toFixed(2)),
      cap: b.cap ?? null,
      tradesToday: b.tradesToday,
      pos: b.position ? `${b.position.side} ${b.position.coin}` : "flat",
    });
  }
};

setTimeout(report, 25_000);
if (process.env.E2E_SECONDS) {
  setTimeout(() => {
    report();
    engine.stop();
    server.close();
    db.close();
    process.exit(0);
  }, Number(process.env.E2E_SECONDS) * 1000);
}
