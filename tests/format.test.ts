import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCompactTokens, formatExactTokens } from "../src/client/format.ts";

test("compact token counts use K/M/B with at most one decimal", () => {
  const cases: Array<[number, string]> = [
    [0, "0"],
    [7, "7"],
    [950, "950"],
    [999, "999"],
    [999.6, "1K"],
    [1_000, "1K"],
    [1_049, "1K"],
    [1_050, "1.1K"],
    [12_345, "12.3K"],
    [99_949, "99.9K"],
    [99_950, "100K"],
    [123_456, "123K"],
    [999_499, "999K"],
    [999_500, "1M"],
    [999_999, "1M"],
    [1_000_000, "1M"],
    [7_512_345, "7.5M"],
    [7_000_001, "7M"],
    [123_456_789, "123M"],
    [999_999_999, "1B"],
    [1_234_567_890, "1.2B"],
    [987_654_321_000, "988B"],
    [1_234_567_890_123, "1,235B"],
    [-7_512_345, "-7.5M"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(formatCompactTokens(value), expected, `formatCompactTokens(${value})`);
  }
});

test("compact token formatting never invents a value for non-finite input", () => {
  assert.equal(formatCompactTokens(Number.NaN), "N/A");
  assert.equal(formatCompactTokens(Number.POSITIVE_INFINITY), "N/A");
});

test("exact token counts keep every digit with en-US separators", () => {
  assert.equal(formatExactTokens(0), "0");
  assert.equal(formatExactTokens(950), "950");
  assert.equal(formatExactTokens(7_512_345), "7,512,345");
  assert.equal(formatExactTokens(1_234_567_890_123), "1,234,567,890,123");
});
