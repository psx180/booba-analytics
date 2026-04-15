/**
 * Regime-mismatch insight.
 *
 * Hypothesis: some trade types perform significantly differently across market
 * regimes. Identifies the worst regime × trade type combination and quantifies
 * the dollar cost of trading that setup in unfavourable conditions.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, formatRegimeLabel } from './base';
import { welchTTest, chiSquaredProportionTest, bonferroniCorrect, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS    = 40;
const MIN_PER_BUCKET   = 10;
const MIN_PER_TYPE     = 10;

export const regimeMismatchDetector: InsightDetector = {
  name: 'regime-mismatch',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'tradeType', 'regimeAtEntry'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.tradeType != null && p.regimeAtEntry != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'regime-mismatch',
        title: 'Regime-Strategy Analysis Pending',
        description: `Need ${needed} more trades with both trade type and regime data. Watching for strategy × regime performance gaps.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('chi_squared', qualified.length)],
        impactScore: 0, category: 'strategy', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by tradeType
    const byType = new Map<string, Position[]>();
    for (const p of qualified) {
      const tt = p.tradeType!;
      if (!byType.has(tt)) byType.set(tt, []);
      byType.get(tt)!.push(p);
    }

    interface Finding {
      tradeType:   string;
      goodRegime:  string;
      badRegime:   string;
      goodWinRate: number;
      badWinRate:  number;
      goodAvgPnl:  number;
      badAvgPnl:   number;
      badTotalPnl: number;
      tests:       StatisticalTest[];
    }

    const findings: Finding[] = [];

    for (const [tradeType, tradePositions] of byType) {
      if (tradePositions.length < MIN_PER_TYPE) continue;

      // Group by regime
      const byRegime = new Map<string, Position[]>();
      for (const p of tradePositions) {
        const r = p.regimeAtEntry!;
        if (!byRegime.has(r)) byRegime.set(r, []);
        byRegime.get(r)!.push(p);
      }

      const regimes = Array.from(byRegime.entries()).filter(([, ps]) => ps.length >= MIN_PER_BUCKET);
      if (regimes.length < 2) continue;

      // All pairwise comparisons
      const allTests: StatisticalTest[] = [];
      interface Comparison {
        regA: string; regB: string;
        avgPnlA: number; avgPnlB: number;
        winRateA: number; winRateB: number;
        pnlTestIdx: number; winRateTestIdx: number;
      }
      const comparisons: Comparison[] = [];

      for (let i = 0; i < regimes.length; i++) {
        for (let j = i + 1; j < regimes.length; j++) {
          const [regA, posA] = regimes[i];
          const [regB, posB] = regimes[j];
          const pnlA   = posA.map((p) => p.aggregatePnl!);
          const pnlB   = posB.map((p) => p.aggregatePnl!);
          const winsA  = posA.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
          const winsB  = posB.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
          const avgPnlA = mean(pnlA);
          const avgPnlB = mean(pnlB);

          const pnlTestIdx     = allTests.length;
          allTests.push(welchTTest(pnlA, pnlB));
          const winRateTestIdx = allTests.length;
          allTests.push(chiSquaredProportionTest(winsA, posA.length, winsB, posB.length));

          comparisons.push({
            regA, regB, avgPnlA, avgPnlB,
            winRateA: Math.round((winsA / posA.length) * 100),
            winRateB: Math.round((winsB / posB.length) * 100),
            pnlTestIdx, winRateTestIdx,
          });
        }
      }

      const corrected = bonferroniCorrect(allTests);
      const sigComps  = comparisons.filter(
        (c) => corrected[c.pnlTestIdx].isSignificant || corrected[c.winRateTestIdx].isSignificant,
      );
      if (sigComps.length === 0) continue;

      // Biggest P&L gap
      const best = sigComps.reduce((b, c) =>
        Math.abs(c.avgPnlA - c.avgPnlB) > Math.abs(b.avgPnlA - b.avgPnlB) ? c : b,
      );

      const goodRegime  = best.avgPnlA >= best.avgPnlB ? best.regA : best.regB;
      const badRegime   = best.avgPnlA >= best.avgPnlB ? best.regB : best.regA;
      const goodAvgPnl  = best.avgPnlA >= best.avgPnlB ? best.avgPnlA : best.avgPnlB;
      const badAvgPnl   = best.avgPnlA >= best.avgPnlB ? best.avgPnlB : best.avgPnlA;
      const goodWinRate = best.avgPnlA >= best.avgPnlB ? best.winRateA : best.winRateB;
      const badWinRate  = best.avgPnlA >= best.avgPnlB ? best.winRateB : best.winRateA;

      const badPositions = byRegime.get(badRegime) ?? [];
      const badTotalPnl  = badPositions.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);

      findings.push({ tradeType, goodRegime, badRegime, goodWinRate, badWinRate, goodAvgPnl, badAvgPnl, badTotalPnl, tests: corrected });
    }

    if (findings.length === 0) {
      return [{
        module: 'regime-mismatch',
        title: 'No Regime-Strategy Mismatch',
        description: `Your trade types perform consistently across regimes — no statistically significant performance gaps detected across ${qualified.length} trades.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { tradeCount: qualified.length },
        statistics: [pending('chi_squared', qualified.length)],
        impactScore: 0, category: 'strategy', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Top finding by dollar impact
    findings.sort((a, b) => Math.abs(b.badTotalPnl) - Math.abs(a.badTotalPnl));
    const top         = findings[0];
    const primaryTest = top.tests.reduce((b, t) => (t.pValue < b.pValue ? t : b));
    const dollarImpact = Math.abs(top.badTotalPnl);
    const impactScore  = computeImpactScore(dollarImpact, primaryTest, 0.7);

    const typeLabel = top.tradeType.replace(/_/g, ' ');

    let description =
      `Your ${typeLabel} trades perform very differently across regimes. ` +
      `In ${formatRegimeLabel(top.goodRegime)}: ${top.goodWinRate}% win rate, avg $${top.goodAvgPnl.toFixed(2)}. ` +
      `In ${formatRegimeLabel(top.badRegime)}: ${top.badWinRate}% win rate, avg $${top.badAvgPnl.toFixed(2)}. ` +
      `${primaryTest.description}. ` +
      `You've lost $${Math.abs(Math.round(top.badTotalPnl)).toLocaleString()} taking ${typeLabel} trades in ${formatRegimeLabel(top.badRegime)} conditions.`;

    if (findings.length > 1) {
      const others = findings.slice(1).map(
        (f) => `${f.tradeType.replace(/_/g, ' ')} in ${formatRegimeLabel(f.badRegime)}`,
      );
      description += ` Also detected in: ${others.join(', ')}.`;
    }

    const suggestion =
      `Consider only taking ${typeLabel} setups during ${formatRegimeLabel(top.goodRegime)} conditions, ` +
      `or adapting your approach significantly for ${formatRegimeLabel(top.badRegime)} markets.`;

    const regimeBreakdown: Record<string, any> = {};
    for (const f of findings) {
      regimeBreakdown[`${f.tradeType}__${f.badRegime}`] = {
        tradeType:   f.tradeType,
        badRegime:   f.badRegime,
        goodRegime:  f.goodRegime,
        badTotalPnl: Math.round(f.badTotalPnl * 100) / 100,
        badWinRate:  f.badWinRate,
        goodWinRate: f.goodWinRate,
      };
    }

    const badRegionIds = qualified
      .filter((p) => p.tradeType === top.tradeType && p.regimeAtEntry === top.badRegime)
      .map((p) => p.id);

    return [{
      module: 'regime-mismatch',
      title: 'Regime-Strategy Mismatch Detected',
      description,
      suggestion,
      severity: dollarImpact > 500 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: badRegionIds,
      data: {
        findingsCount:  findings.length,
        topTradeType:   top.tradeType,
        topBadRegime:   top.badRegime,
        topGoodRegime:  top.goodRegime,
        topDollarImpact: Math.round(top.badTotalPnl * 100) / 100,
        tradeCount:     qualified.length,
      },
      regimeBreakdown,
      statistics: top.tests,
      impactScore,
      category: 'strategy',
      isSignificant: true,
      sampleSize: qualified.length,
    }];
  },
};

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }

function pending(testName: string, n: number): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
