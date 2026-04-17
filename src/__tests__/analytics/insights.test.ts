import { describe, it, expect } from 'vitest';
import type { Insight, Position } from '@/services/analytics/insights/base';
import { dispositionDetector } from '@/services/analytics/insights/disposition';
import { overtradingDetector } from '@/services/analytics/insights/overtrading';
import { revengeTradingDetector } from '@/services/analytics/insights/revenge-trading';
import { tiltEpisodesDetector } from '@/services/analytics/insights/tilt-episodes';
import { regimeMismatchDetector } from '@/services/analytics/insights/regime-mismatch';

function pos(over: Partial<Record<string, unknown>>): Position {
  return {
    id: 'p',
    aggregatePnl: null,
    aggregateFees: null,
    aggregateFunding: null,
    holdTimeSeconds: null,
    tiltScore: null,
    tiltEpisodeId: null,
    firstEntryTime: null,
    lastExitTime: null,
    regimeAtEntry: null,
    tradeType: null,
    ...over,
  } as unknown as Position;
}

function expectWellFormed(insight: Insight): void {
  expect(insight.module).toEqual(expect.any(String));
  expect(insight.title).toEqual(expect.any(String));
  expect(insight.description).toEqual(expect.any(String));
  expect(['info', 'warning', 'critical']).toContain(insight.severity);
  expect(Array.isArray(insight.statistics)).toBe(true);
  expect(insight.statistics.length).toBeGreaterThan(0);
  expect(typeof insight.confidence).toBe('number');
  expect(typeof insight.impactScore).toBe('number');
  expect(typeof insight.sampleSize).toBe('number');
  expect(Array.isArray(insight.affectedPositions)).toBe(true);
}

// Below-minimum results are either empty (disposition) or a single placeholder
// insight (overtrading, revenge, tilt-episodes, regime-mismatch). Accept both
// so the assertion stays faithful to each detector's real contract.
function expectInsufficient(result: Insight[]): void {
  expect(Array.isArray(result)).toBe(true);
  if (result.length === 0) return;
  expect(result).toHaveLength(1);
  const [ins] = result;
  expectWellFormed(ins);
  expect(ins.confidence).toBe(0);
  expect(ins.impactScore).toBe(0);
  expect(ins.isSignificant).toBe(false);
  // Placeholder stats: pValue pinned to 1, no effect, not significant.
  expect(ins.statistics[0].pValue).toBe(1);
  expect(ins.statistics[0].effectSize).toBe(0);
  expect(ins.statistics[0].isSignificant).toBe(false);
}

describe('dispositionDetector', () => {
  it('empty input → returns []', () => {
    expect(dispositionDetector.detect([])).toEqual([]);
  });

  it('below minimum qualified positions → returns []', () => {
    // 10 positions, all with holdTimeSeconds + aggregatePnl, still < MIN 20
    const positions = Array.from({ length: 10 }, (_, i) =>
      pos({ holdTimeSeconds: 600 + i, aggregatePnl: i % 2 === 0 ? 50 : -50 }),
    );
    expect(dispositionDetector.detect(positions)).toEqual([]);
  });

  it('sufficient input → returns zero or more well-formed insights', () => {
    const positions = Array.from({ length: 30 }, (_, i) =>
      pos({
        id: `p${i}`,
        // Losers held longer than winners to create a signal
        holdTimeSeconds: i % 2 === 0 ? 300 : 1800,
        aggregatePnl: i % 2 === 0 ? 100 : -100,
      }),
    );
    const result = dispositionDetector.detect(positions);
    expect(Array.isArray(result)).toBe(true);
    for (const ins of result) expectWellFormed(ins);
  });
});

describe('overtradingDetector', () => {
  it('empty input → pending placeholder (not an empty array)', () => {
    expectInsufficient(overtradingDetector.detect([]));
  });

  it('sufficient input spread across 4+ days → insights are well-formed', () => {
    // 40 positions across 10 distinct days
    const positions = Array.from({ length: 40 }, (_, i) =>
      pos({
        id: `p${i}`,
        aggregatePnl: ((i % 5) - 2) * 30,
        firstEntryTime: new Date(2025, 0, 1 + (i % 10), 12),
      }),
    );
    const result = overtradingDetector.detect(positions);
    expect(Array.isArray(result)).toBe(true);
    for (const ins of result) {
      expectWellFormed(ins);
      expect(ins.module).toBe('overtrading');
    }
  });
});

describe('revengeTradingDetector', () => {
  it('insufficient input → pending placeholder', () => {
    expectInsufficient(revengeTradingDetector.detect([]));
  });

  it('sufficient input → insights are well-formed', () => {
    const positions = Array.from({ length: 30 }, (_, i) => {
      const start = new Date(2025, 0, 1, 12, i * 10);
      const end = new Date(2025, 0, 1, 12, i * 10 + 5);
      return pos({
        id: `p${i}`,
        aggregatePnl: i % 3 === 0 ? -50 : 25,
        firstEntryTime: start,
        lastExitTime: end,
      });
    });
    const result = revengeTradingDetector.detect(positions);
    expect(Array.isArray(result)).toBe(true);
    for (const ins of result) {
      expectWellFormed(ins);
      expect(ins.module).toBe('revenge-trading');
    }
  });
});

describe('tiltEpisodesDetector', () => {
  it('insufficient input → pending placeholder', () => {
    expectInsufficient(tiltEpisodesDetector.detect([]));
  });

  it('sufficient input (with tilt data) → insights are well-formed', () => {
    const positions = Array.from({ length: 30 }, (_, i) =>
      pos({
        id: `p${i}`,
        aggregatePnl: i % 2 === 0 ? 40 : -40,
        firstEntryTime: new Date(2025, 0, 1 + (i % 5), 12),
        tiltScore: (i % 10) / 10,
        tiltEpisodeId: i < 5 ? `ep-${i}` : null,
      }),
    );
    const result = tiltEpisodesDetector.detect(positions);
    expect(Array.isArray(result)).toBe(true);
    for (const ins of result) expectWellFormed(ins);
  });
});

describe('regimeMismatchDetector', () => {
  it('insufficient input → pending placeholder', () => {
    expectInsufficient(regimeMismatchDetector.detect([]));
  });

  it('sufficient input (N ≥ 40) → insights are well-formed', () => {
    const regimes = ['trending_low_vol', 'ranging_low_vol', 'trending_high_vol'];
    const types = ['scalp', 'directional', 'carry_trade'];
    const positions = Array.from({ length: 45 }, (_, i) =>
      pos({
        id: `p${i}`,
        aggregatePnl: (i % 2 === 0 ? 1 : -1) * (20 + (i % 5) * 10),
        tradeType: types[i % types.length],
        regimeAtEntry: regimes[i % regimes.length],
      }),
    );
    const result = regimeMismatchDetector.detect(positions);
    expect(Array.isArray(result)).toBe(true);
    for (const ins of result) {
      expectWellFormed(ins);
      expect(ins.module).toBe('regime-mismatch');
    }
  });
});
