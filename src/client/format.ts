// Pure number formatting for the dashboard. Kept free of React and DOM APIs so
// the rules can be unit-tested in Node.

const EXACT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const UNITS = [
  { size: 1_000, suffix: "K" },
  { size: 1_000_000, suffix: "M" },
  { size: 1_000_000_000, suffix: "B" },
] as const;

/** Full token count with thousands separators, e.g. "7,512,345". */
export function formatExactTokens(value: number): string {
  return EXACT.format(value);
}

/**
 * Short token count for dense views: "950", "12.3K", "7.5M", "123M", "1.2B".
 * One decimal below 100 units, none above; a trailing ".0" is dropped. Rounding
 * never produces "1000K" – it moves to the next unit ("1M") instead.
 */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (Math.round(absolute) < 1_000) return sign + EXACT.format(absolute);

  let index = UNITS.length - 1;
  while (index > 0 && absolute < UNITS[index].size) index -= 1;

  let text = shortNumber(absolute / UNITS[index].size);
  while (Number(text) >= 1_000 && index < UNITS.length - 1) {
    index += 1;
    text = shortNumber(absolute / UNITS[index].size);
  }
  // Beyond 999B the largest unit keeps growing: "1,235B".
  if (Number(text) >= 1_000) text = EXACT.format(Number(text));
  return `${sign}${text}${UNITS[index].suffix}`;
}

function shortNumber(scaled: number): string {
  const oneDecimal = Math.round(scaled * 10) / 10;
  if (oneDecimal < 100) return oneDecimal.toFixed(1).replace(/\.0$/, "");
  return String(Math.round(scaled));
}
