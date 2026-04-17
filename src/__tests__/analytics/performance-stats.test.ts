import { describe, it, expect } from 'vitest';
import {
  computePerformanceStats,
  type Position,
} from '@/services/analytics/aggregations/base';

function pos(
  over: Partial<Position> & {
    aggregatePnl?: number | null;
    aggregateFees?: number | null;
    aggregateFunding?: number | null;
    tiltScore?: number | null;
    tiltEpisodeId?: string | null;
  },
): Position {
  return {
    aggregatePnl: null,
    aggregateFees: null,
    aggregateFunding: null,
    tiltScore: null,
    tiltEpisodeId: null,
    ...over,
  } as unknown as Position;
}

describe('computePerformanceStats', () => {
  it('returns zeroed defaults for an empty array (no divide-by-zero)', () => {
    const stats = computePerformanceStats([]);
    expect(stats.tradeCount).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.lossRate).toBe(0);
    expect(stats.expectancy).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.totalPnl).toBe(0);
    expect(Number.isFinite(stats.expectancy)).toBe(true);
  });

  it('pure wins: winRate=1, profitFactor sentinel (999), positive expectancy', () => {
    const positions = [
      pos({ aggregatePnl: 100 }),
      pos({ aggregatePnl: 250 }),
      pos({ aggregatePnl: 50 }),
    ];
    const stats = computePerformanceStats(positions);
    expect(stats.tradeCount).toBe(3);
    expect(stats.winRate).toBe(1);
    expect(stats.lossRate).toBe(0);
    expect(stats.averageWin).toBe(133.33);
    expect(stats.averageLoss).toBe(0);
    expect(stats.profitFactor).toBe(999);
    expect(stats.expectancy).toBe(133.33);
    expect(stats.totalPnl).toBe(400);
  });

  it('pure losses: winRate=0, negative expectancy, profitFactor=0', () => {
    const positions = [
      pos({ aggregatePnl: -100 }),
      pos({ aggregatePnl: -200 }),
      pos({ aggregatePnl: -300 }),
    ];
    const stats = computePerformanceStats(positions);
    expect(stats.tradeCount).toBe(3);
    expect(stats.winRate).toBe(0);
    expect(stats.lossRate).toBe(1);
    expect(stats.averageWin).toBe(0);
    expect(stats.averageLoss).toBe(-200);
    expect(stats.profitFactor).toBe(0);
    expect(stats.expectancy).toBeLessThan(0);
    expect(stats.expectancy).toBe(-200);
  });

  it('mixed set: asserts exact expectancy / win-rate / profit factor', () => {
    // +100, +200, -50 → totalPnl 250, winRate 2/3, avgWin 150, avgLoss -50
    // profitFactor = 300 / 50 = 6, expectancy = 250 / 3 ≈ 83.33
    const positions = [
      pos({ aggregatePnl: 100, aggregateFees: 1, aggregateFunding: 2 }),
      pos({ aggregatePnl: 200, aggregateFees: 1 }),
      pos({ aggregatePnl: -50, aggregateFees: 1 }),
    ];
    const stats = computePerformanceStats(positions);
    expect(stats.tradeCount).toBe(3);
    expect(stats.winRate).toBe(0.6667);
    expect(stats.lossRate).toBe(0.3333);
    expect(stats.averageWin).toBe(150);
    expect(stats.averageLoss).toBe(-50);
    expect(stats.profitFactor).toBe(6);
    expect(stats.expectancy).toBe(83.33);
    expect(stats.totalPnl).toBe(250);
    expect(stats.totalFees).toBe(3);
    expect(stats.totalFunding).toBe(2);
  });

  it('treats zero-pnl positions as neither wins nor losses', () => {
    const positions = [
      pos({ aggregatePnl: 0 }),
      pos({ aggregatePnl: 100 }),
      pos({ aggregatePnl: 0 }),
      pos({ aggregatePnl: -50 }),
    ];
    const stats = computePerformanceStats(positions);
    expect(stats.tradeCount).toBe(4);
    expect(stats.winRate).toBe(0.25);
    expect(stats.lossRate).toBe(0.25);
    expect(stats.profitFactor).toBe(2);
  });

  it('tilt aggregates: avg only over positions with tiltScore, coverage as fraction', () => {
    const positions = [
      pos({ aggregatePnl: 10, tiltScore: 0.8, tiltEpisodeId: 'e1' }),
      pos({ aggregatePnl: 10, tiltScore: 0.4, tiltEpisodeId: 'e1' }),
      pos({ aggregatePnl: 10 }),
      pos({ aggregatePnl: 10, tiltEpisodeId: 'e2' }),
    ];
    const stats = computePerformanceStats(positions);
    expect(stats.avgTiltScore).toBe(0.6);
    expect(stats.tiltCoverage).toBe(0.5);
    expect(stats.tiltEpisodeCount).toBe(2);
  });
});
