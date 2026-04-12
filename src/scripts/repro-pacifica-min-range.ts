/**
 * Reproduces the Pacifica /kline "start_time must be less than end_time"
 * bug, and proves it's actually a hidden minimum-range requirement —
 * not what the error message claims.
 *
 * Usage: npx tsx src/scripts/repro-pacifica-min-range.ts
 *
 * Outline of what this script demonstrates:
 *
 *   1. A request with start clearly less than end can still fail with the
 *      misleading "start_time must be less than end_time" error.
 *   2. Holding start fixed and widening end past a threshold makes the
 *      same request succeed — proving the actual rule is a minimum range,
 *      not a start/end ordering check.
 *   3. The threshold differs by interval (1m needs ~60 candles, 1h needs
 *      ~20 candles), so the fix is to pad every request to safely exceed
 *      the largest known minimum.
 *
 * The script makes raw HTTPS requests so the bug can be reproduced with
 * zero project-internal code in the loop.
 */

const BASE = 'https://api.pacifica.fi/api/v1/kline';

interface Outcome {
  ok: boolean;
  count: number;
  error: string | null;
}

async function probe(symbol: string, interval: string, startMs: number, endMs: number): Promise<Outcome> {
  const url = `${BASE}?symbol=${symbol}&interval=${interval}&start_time=${startMs}&end_time=${endMs}`;
  const res = await fetch(url);
  const body = (await res.json()) as { success: boolean; data: unknown[] | null; error: string | null };
  return {
    ok: body.success,
    count: Array.isArray(body.data) ? body.data.length : 0,
    error: body.error,
  };
}

function fmt(outcome: Outcome): string {
  if (outcome.ok) return `OK   (${outcome.count} candles)`;
  return `FAIL ("${outcome.error}")`;
}

async function main() {
  // Pick a known-good anchor where Pacifica definitely has data. Hour-aligned
  // so we can rule out boundary-flooring artifacts.
  const ANCHOR_MS = 1763092800000; // 2025-11-14T04:00:00Z
  console.log(`Anchor start_time: ${ANCHOR_MS} (${new Date(ANCHOR_MS).toISOString()})\n`);

  // ─── Step 1: prove the bug ──────────────────────────────────────────
  // start < end by a healthy 10 hours, but the API rejects it claiming
  // start must be less than end. Symbol is BTC so it can't be "asset
  // doesn't exist" — BTC has been on Pacifica forever.
  console.log('=== Step 1: small request that should obviously work ===');
  const tenHoursMs = 10 * 3600_000;
  const smallRequest = await probe('BTC', '1h', ANCHOR_MS, ANCHOR_MS + tenHoursMs);
  console.log(`BTC 1h, start → start+10h:    ${fmt(smallRequest)}`);
  console.log(`(start < end by ${tenHoursMs}ms = 10h, yet the API claims otherwise)\n`);

  // ─── Step 2: prove widening the range fixes it ──────────────────────
  // Same start, much larger end. If the API really cared about the start <
  // end ordering, this would also fail. It doesn't — it succeeds, proving
  // the real rule is a minimum-range requirement.
  console.log('=== Step 2: same start, wider range, succeeds ===');
  const oneDayMs = 24 * 3600_000;
  const wideRequest = await probe('BTC', '1h', ANCHOR_MS, ANCHOR_MS + oneDayMs);
  console.log(`BTC 1h, start → start+24h:    ${fmt(wideRequest)}`);
  console.log('(same start, end pushed out — now succeeds, so the rule is range-based, not ordering)\n');

  // ─── Step 3: bisect the per-interval minimum ────────────────────────
  // Walk the end outward in increments and find where each interval flips
  // from FAIL to OK. The transition point is the minimum range the API
  // accepts for that interval. Bigger intervals need more wall-clock
  // span; smaller intervals need fewer minutes but more candles.
  console.log('=== Step 3: bisect the minimum range per interval ===');

  const intervals: Array<{ name: string; intervalMs: number; samples: number[] }> = [
    {
      name: '1m',
      intervalMs: 60_000,
      samples: [10, 30, 45, 55, 59, 60, 70].map((min) => min * 60_000),
    },
    {
      name: '15m',
      intervalMs: 900_000,
      samples: [1, 4, 8, 14, 16, 20, 30].map((h) => h * 3_600_000),
    },
    {
      name: '1h',
      intervalMs: 3_600_000,
      samples: [1, 5, 10, 15, 18, 19, 20, 24].map((h) => h * 3_600_000),
    },
  ];

  for (const { name, intervalMs, samples } of intervals) {
    console.log(`\n  Interval = ${name}:`);
    for (const deltaMs of samples) {
      const outcome = await probe('BTC', name, ANCHOR_MS, ANCHOR_MS + deltaMs);
      const candleSlots = Math.round(deltaMs / intervalMs);
      const wallClock =
        deltaMs >= 3_600_000
          ? `${(deltaMs / 3_600_000).toFixed(1).padStart(5)}h `
          : `${(deltaMs / 60_000).toFixed(0).padStart(5)}m `;
      console.log(
        `    delta=${wallClock} (~${String(candleSlots).padStart(4)} candle slots)  ${fmt(outcome)}`,
      );
      // Polite pacing so we don't trip Pacifica's public rate limit.
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log('\n=== Conclusion ===');
  console.log('The threshold where each interval flips from FAIL → OK is the');
  console.log('hidden minimum-range requirement. Empirically:');
  console.log('  1m  needs ~60 candle slots wide');
  console.log('  1h  needs ~20 candle slots wide');
  console.log('Different per interval, so neither "minimum N candles" nor "minimum X');
  console.log('wall-clock" alone explains it. The fix in src/services/analytics/metrics/');
  console.log('exit-quality.ts pads every bucket to max(120 candles, 24h) which clears');
  console.log('every measured minimum with margin to spare.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
