// Our own crypto / stock / commodity tagging. OKX has no field for this.
// Source: docs/xperps_eea_2026-09-24.json, plus the native Hyperliquid perps (HL_NATIVE below).
// Anything not listed is "unknown" and is never traded (logged at startup so it can be classified by hand).
// Stocks and commodities need ALLOW_NON_CRYPTO=true, which stays false until their trading hours are verified.
//
// Venue note: OKX EEA lists ~29 X-Perps, Hyperliquid ~178 native perps, so this list is longer than OKX's alone.
// `kXXX` names are Hyperliquid's 1000x-multiplier wrappers (kPEPE = 1000 PEPE): real crypto, not a separate
// asset class. HIP-3 builder perps arrive as "dex:COIN" (e.g. "xyz:AAPL") and are deliberately NOT listed:
// they resolve to "unknown" and are never traded until their trading hours are verified.

export type Kind = "crypto" | "stock" | "commodity" | "test" | "unknown";

const CRYPTO = new Set(
  "0G AAVE ACT ACU ADA AEON AERO AGLD AI ALGO ALLO APR APT ARB ARX ASTER ATOM AVAX AVNT BASED BCH BEAT BICO BILL BIO BNB BONK BSB BTC CAP CASHCAT CFX CHIP CNPY CP CRV DASH DGAI DOGE DOS DOT DYDX EDGE ENA ENSO ESP ETC ETH ETHFI FET FIL FLOCK GALA GRAM GRASS GRVT H HBAR HOME HYPE ICP INJ IOST IRYS JTO JUP KAITO KITE KMNO KSM LDO LINK LIT LTC MINA MON MOODENG MORPHO NEAR NES NIGHT NOT O OL ONDO ONT OP OPN ORDI PENDLE PENGU PEPE PIEVERSE POL PONS PROS PUMP PYTH RAVE RAY RE RENDER RESOLV RLS ROBO SAHARA SEI SHIB SLX SOL SOPH SPK STRK STX SUI SUSHI TAO TIA TRB TRIA TRUMP TRX UB UNI UP USELESS VIRTUAL VVV WIF WLD WLFI XLM XPL XRP YB ZAMA ZEC ZEN ZIL ZKP ZRO".split(" "),
);
/**
 * Native Hyperliquid perps that OKX EEA does not list, so they classified as "unknown" before. Every name is a
 * real crypto perp on Hyperliquid's main perp dex (checked against the live `meta` response); the `kXXX` entries
 * are its 1000x-multiplier wrappers.
 */
const HL_NATIVE = new Set(
  "2Z ACE AIXBT ALT ANIME APE APEX AR AXS AZTEC BABY BANANA BERA BIGTIME BLUR BOME BRETT BSV CAKE CC CELO COMP DYM EIGEN ENS FARTCOIN FOGO GAS GMT GMX GOAT GRIFFAIN HEMI HMSTR HYPER IMX INIT IO IOTA KAS LAYER LINEA MANTA ME MEGA MELANIA MEME MERL MET MNT MOVE NEO NIL NXPC PAXG PEOPLE PNUT POLYX POPCAT PROVE PURR REZ RSR RUNE S SAGA SAND SKR SKY SNX SPX STABLE STBL SUPER SYRUP TNSR TURBO UMA USUAL W WCT XAI XMR YGG ZETA ZK ZORA kBONK kFLOKI kLUNC kNEIRO kPEPE kSHIB".split(" "),
);

const COMMODITY = new Set(["BZ", "CL", "XAG", "XAU"]);
const STOCK = new Set(
  "AAOI AAPL AMAT AMD AMZN ANTHROPIC ARM ASTS AVGO AXTI BE BMNR CBRS COHR COIN CRCL CRDO CRWV DELL DRAM EWY FLNC GLW GOOGL HOOD INTC IONQ IREN KO KORU LITE META MINIMAX MRNA MRVL MSFT MSTR MU MUU NBIS NVDA OKTA OPENAI ORCL PLTR QCOM QQQ RKLB SAMSUNG SKHY SKHYNIX SMCI SNDK SNXX SOFTBANK SOXL SOXS SPCX SPY TSLA TSM USAR WDC XIAOMI ZHIPU".split(" "),
);

export function kindOf(coin: string): Kind {
  if (coin.startsWith("TEST")) return "test";
  if (CRYPTO.has(coin) || HL_NATIVE.has(coin)) return "crypto";
  if (COMMODITY.has(coin)) return "commodity";
  if (STOCK.has(coin)) return "stock";
  return "unknown";
}
