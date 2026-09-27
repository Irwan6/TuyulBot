import { describe, expect, it } from "vitest";
import { formatPx, formatSz } from "../src/exec/hyperliquid.js";

// These two formatters are the only thing standing between a signed order and a venue rejection: Hyperliquid
// checks price tick size, size lot size, and a $10 minimum notional, and answers with an opaque error for each.

describe("formatPx", () => {
  it("keeps 5 significant figures and never more than 6 - szDecimals decimals", () => {
    // BTC: szDecimals 5 -> at most 1 decimal, and 5 sig figs wins.
    expect(formatPx(84591.123456, 5)).toBe("84591.0");
    // SOL: szDecimals 2 -> up to 4 decimals.
    expect(formatPx(120.726789, 2)).toBe("120.7300");
    // HYPE: szDecimals 2.
    expect(formatPx(93.54123, 2)).toBe("93.5410");
  });

  it("rounds rather than truncates at the 5th significant figure", () => {
    expect(formatPx(93.54199, 2)).toBe("93.5420");
    expect(formatPx(1.999999, 1)).toBe("2.00000");
  });

  it("pads with zeros to the allowed decimal count, which the venue accepts", () => {
    // szDecimals 0 -> 6 decimals allowed, 5 sig figs still binds, and toFixed pads to 6 places.
    // Verified against the live testnet exchange endpoint: "127140.0" passed price validation and was rejected
    // only on the $10 minimum notional, so zero padding is not a problem the venue cares about.
    expect(formatPx(4.76781234, 0)).toBe("4.767800");
    expect(formatPx(1.52169, 0)).toBe("1.521700");
  });

  it("never returns more decimals than the venue allows, for any szDecimals", () => {
    for (let szDec = 0; szDec <= 6; szDec++) {
      const out = formatPx(12345.6789, szDec);
      const decimals = out.includes(".") ? out.split(".")[1]!.length : 0;
      expect(decimals).toBeLessThanOrEqual(Math.max(0, 6 - szDec));
    }
  });

  it("produces a positive, 5-significant-figure price for every real mainnet coin", () => {
    // Real (coin, mid, szDecimals) triples sampled from live Hyperliquid mainnet metadata. The risk here is a
    // low-priced coin whose 5 sig figs fall below the allowed decimal count and collapse to "0.0".
    const real: Array<[string, number, number]> = [
      ["BTC", 84485.5, 5],
      ["ETH", 4123.45, 4],
      ["SOL", 121.305, 2],
      ["HYPE", 92.8045, 2],
      ["XRP", 1.5217, 0],
      ["DOGE", 0.24123, 0],
      ["SUI", 3.1234, 0],
      ["PUMP", 0.004123, 0],
      ["WLD", 1.2345, 0],
      ["PAXG", 4281.85, 3],
      ["ZEC", 1654.75, 2],
      ["AAVE", 156.245, 2],
    ];
    for (const [coin, mid, szDec] of real) {
      const out = formatPx(mid, szDec);
      expect(Number(out), `${coin} priced at ${mid}`).toBeGreaterThan(0);
      expect(out.replace(/[^1-9]/g, "").length, `${coin} sig figs`).toBeGreaterThanOrEqual(4);
      // The tick-size rule: no more decimals than 6 - szDecimals, or the venue rejects the order outright.
      const decimals = out.includes(".") ? out.split(".")[1]!.length : 0;
      expect(decimals, `${coin} decimals`).toBeLessThanOrEqual(Math.max(0, 6 - szDec));
    }
  });
});

describe("formatSz", () => {
  it("floors to the lot step so a close never over-fills", () => {
    expect(formatSz(283.91234, 1e-5)).toBe("283.91234");
    expect(formatSz(0.00438123, 1e-5)).toBe("0.00438");
    expect(formatSz(1220.99999, 1e-4)).toBe("1220.9999");
  });

  it("returns 0 for a size below one lot, which the executor then rejects as SIZE", () => {
    expect(formatSz(0.0000001, 1e-5)).toBe("0.00000");
    expect(Number(formatSz(0.0000001, 1e-5))).toBe(0);
  });

  it("floors rather than rounds, even when rounding up would be closer", () => {
    // 0.0000199 is closer to 0.00002, but flooring to 1e-5 must give 0.00001.
    expect(formatSz(0.0000199, 1e-5)).toBe("0.00001");
  });

  it("handles a whole-unit lot", () => {
    expect(formatSz(12.9, 1)).toBe("12");
    expect(formatSz(0.9, 1)).toBe("0");
  });

  it("is stable against floating point drift", () => {
    // 0.3 / 0.1 is 2.9999999999999996: a naive floor would give 0.2 instead of 0.3.
    expect(formatSz(0.3, 0.1)).toBe("0.3");
    expect(formatSz(1.1, 0.1)).toBe("1.1");
  });
});
