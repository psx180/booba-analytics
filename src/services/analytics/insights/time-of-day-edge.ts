/**
 * Time-of-day edge insight.
 *
 * Two complementary analyses, both reported in the same insight card:
 *
 *   1. Per-hour edge — hypothesis that some hours of the day are significantly
 *      better or worse than all other hours. Bonferroni correction over 24
 *      comparisons. (Original analysis.)
 *
 *   2. Within-session decision fatigue — for each trade compute its
 *      `tradeNumberInSession` (how many trades the user has already taken
 *      that day), then look for performance decay as the day wears on.
 *      Welch t-test on early-session (trades 1-3) vs late-session (4+).
 *      Also finds the optimal stopping point N that maximises early-session
 *      average P&L and quantifies the dollar cost of trades past N.
 *
 * The two questions are different — "which hours are best?" vs "do you get
 * worse as you trade more?" — so the fatigue analysis is additive rather
 * than a replacement.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, pearsonCorrelation, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 50;
const MIN_HOUR_N    = 10;

export const timeOfDayEdgeDetector: InsightDetector = {
  name: 'time-of-day-edge',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'entryHour', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    // Accept entryHour if computed, otherwise derive from firstEntryTime (UTC).
    // Carry firstEntryTime forward so the fatigue analysis can group by date.
    const qualified = positions
      .filter((p) => p.aggregatePnl != null && (p.entryHour != null || p.firstEntryTime != null))
      .map((p) => ({
        id:          p.id,
        aggregatePnl: p.aggregatePnl!,
        entryHour:   p.entryHour ?? new Date(p.firstEntryTime!).getUTCHours(),
        firstEntryTime: p.firstEntryTime ?? null,
      }));

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'time-of-day-edge',
        title: 'Time-of-Day Analysis Pending',
        description: `Need ${needed} more trades spread across hours before time-of-day edge analysis is reliable.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'timing', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by hour
    const hourMap = new Map<number, number[]>(); // hour → pnls
    for (const p of qualified) {
      const h = p.entryHour;
      if (!hourMap.has(h)) hourMap.set(h, []);
      hourMap.get(h)!.push(p.aggregatePnl);
    }

    // Test each hour with ≥10 trades against the complement
    const hourResults: { hour: number; avgPnl: number; count: number; test: StatisticalTest }[] = [];

    for (const [hour, pnls] of hourMap) {
      if (pnls.length < MIN_HOUR_N) continue;
      const complement = qualified.filter((p) => p.entryHour !== hour).map((p) => p.aggregatePnl);
      if (complement.length < 2) continue;
      const test    = welchTTest(pnls, complement);
      const avgPnl  = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      hourResults.push({ hour, avgPnl, count: pnls.length, test });
    }

    if (hourResults.length === 0) {
      return [{
        module: 'time-of-day-edge',
        title: 'Time-of-Day Analysis Pending',
        description: `No single hour has ${MIN_HOUR_N}+ trades yet. Need more trading data spread across hours.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { tradeCount: qualified.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'timing', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    const withCorrected = hourResults; // raw p-values; global BH handles multiplicity

    const significant = withCorrected.filter((h) => h.test.isSignificant);
    const bestHour    = withCorrected.reduce((b, h) => (h.avgPnl > b.avgPnl ? h : b));
    const worstHour   = withCorrected.reduce((w, h) => (h.avgPnl < w.avgPnl ? h : w));

    const sigBest  = significant.length > 0
      ? significant.reduce((b, h) => (h.avgPnl > b.avgPnl ? h : b))
      : null;
    const sigWorst = significant.length > 0
      ? significant.reduce((w, h) => (h.avgPnl < w.avgPnl ? h : w))
      : null;

    let description: string;
    let suggestion:  string | undefined;

    if (significant.length === 0) {
      description =
        `After testing all ${withCorrected.length} active hours: ` +
        `no hour-of-day edge detected — your performance is consistent across trading hours. ` +
        `Best hour: ${bestHour.hour}:00 (avg $${bestHour.avgPnl.toFixed(2)}), ` +
        `worst: ${worstHour.hour}:00 (avg $${worstHour.avgPnl.toFixed(2)}).`;
    } else {
      const bestStr  = sigBest  ? `Your best hour is ${sigBest.hour}:00 (avg $${sigBest.avgPnl.toFixed(2)}, ${sigBest.test.description})`   : '';
      const worstStr = sigWorst ? `Your worst is ${sigWorst.hour}:00 (avg $${sigWorst.avgPnl.toFixed(2)}, ${sigWorst.test.description})` : '';
      description =
        `After testing all ${withCorrected.length} active hours: ` +
        `${significant.length} hour${significant.length > 1 ? 's' : ''} show significant differences. ` +
        `${bestStr}. ${worstStr}.`;
      if (sigBest && sigWorst) {
        suggestion = `Consider focusing your trading during ${sigBest.hour}:00 and reducing activity during ${sigWorst.hour}:00.`;
      }
    }

    // Dollar impact: losses from worst hour
    const worstHourPnls    = hourMap.get(worstHour.hour) ?? [];
    const worstHourTotalPnl = worstHourPnls.reduce((a, b) => a + b, 0);
    const dollarImpact      = Math.abs(Math.min(0, worstHourTotalPnl));

    const rawTests = withCorrected.map((h) => h.test);
    const bestTestForImpact = rawTests.reduce((b, t) => (t.pValue < b.pValue ? t : b), rawTests[0]);
    const impactScore       = computeImpactScore(dollarImpact, bestTestForImpact, 0.7);
    const isSignificant     = significant.length > 0;

    const worstHourPositionIds = qualified.filter((p) => p.entryHour === worstHour.hour).map((p) => p.id);

    // ─── Decision-fatigue regression ─────────────────────────────────────
    // Significance gate is the OLS slope test on `pnl ~ tradeNumberInSession`,
    // which is a legitimate global test of "does P&L decay as the session
    // wears on." The optimal cutoff and the early/late averages are reported
    // *descriptively* — they were selected post-hoc to maximise the early
    // average, so the narrative carries an explicit caveat. The earlier
    // version of this code ran a second Welch test on that same snooped
    // split; that test was removed because its p-value inherited the
    // selection bias and double-counted in BH.
    const fatigue = computeFatigueAnalysis(qualified);
    let fatigueDescription = '';
    if (fatigue && fatigue.isSignificant) {
      fatigueDescription =
        ` Within each session, your performance declines as you trade more ` +
        `(${fatigue.slopeTest.description}). ` +
        `Trades 1-${fatigue.optimalCutoff} average $${fatigue.earlyAvg.toFixed(2)}, ` +
        `trades ${fatigue.optimalCutoff + 1}+ average $${fatigue.lateAvg.toFixed(2)} ` +
        `(optimal cutoff selected post-hoc — interpret as approximate). ` +
        `Daily trade limit suggestion: ${fatigue.optimalCutoff} trades. ` +
        `Estimated savings from stopping earlier: $${Math.round(fatigue.estimatedSavings).toLocaleString()}.`;
    } else if (fatigue) {
      fatigueDescription =
        ` Within-session performance showed no statistically significant fatigue pattern ` +
        `(${fatigue.slopeTest.description}).`;
    }

    const fatigueStats = fatigue ? [fatigue.slopeTest] : [];
    const finalStatistics = [...rawTests, ...fatigueStats];

    return [{
      module: 'time-of-day-edge',
      title: isSignificant ? 'Time-of-Day Edge Detected' : 'No Time-of-Day Edge',
      description: description + fatigueDescription,
      suggestion,
      severity: 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: worstHourPositionIds,
      data: {
        testedHours:     withCorrected.length,
        significantHours: significant.length,
        bestHour:        bestHour.hour,
        worstHour:       worstHour.hour,
        bestHourAvgPnl:  Math.round(bestHour.avgPnl * 100) / 100,
        worstHourAvgPnl: Math.round(worstHour.avgPnl * 100) / 100,
        tradeCount:      qualified.length,
        fatigue: fatigue
          ? {
              optimalCutoff:    fatigue.optimalCutoff,
              earlyAvg:         Math.round(fatigue.earlyAvg * 100) / 100,
              lateAvg:          Math.round(fatigue.lateAvg * 100) / 100,
              fatigueSlope:     Math.round(fatigue.slope * 1000) / 1000,
              estimatedSavings: Math.round(fatigue.estimatedSavings * 100) / 100,
              maxTradesPerDay:  fatigue.maxTradesPerDay,
              // Consumers (convergence card, psychology tab, live toast) gate
              // their "fatigue detected" copy on this flag. Rows persisted
              // before this field existed will read as undefined, which the
              // consumers treat as not significant.
              isSignificant:    fatigue.isSignificant,
            }
          : null,
      },
      statistics: finalStatistics,
      impactScore,
      category: 'timing',
      isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

// ─── Decision fatigue helpers ─────────────────────────────────────────────

interface FatigueResult {
  slope: number;             // OLS slope of pnl ~ tradeNumberInSession
  slopeTest: StatisticalTest; // Pearson r (== slope t-test) — gates the narrative
  isSignificant: boolean;    // shortcut for slopeTest.isSignificant
  optimalCutoff: number;     // post-hoc selected cutoff that maximises early-session avg P&L
  earlyAvg: number;          // descriptive — selection-biased, do not test
  lateAvg: number;           // descriptive — selection-biased, do not test
  estimatedSavings: number;  // sum of pnl for trades past the optimal cutoff
  maxTradesPerDay: number;
}

interface QualifiedTrade {
  id: string;
  aggregatePnl: number;
  entryHour: number;
  firstEntryTime: Date | null;
}

function computeFatigueAnalysis(qualified: QualifiedTrade[]): FatigueResult | null {
  // Group by trading day. Without firstEntryTime we can't sequence within a
  // day, so anything missing it gets dropped from the fatigue analysis.
  const byDay = new Map<string, QualifiedTrade[]>();
  for (const t of qualified) {
    if (!t.firstEntryTime) continue;
    const dayKey = t.firstEntryTime.toISOString().slice(0, 10);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(t);
  }
  if (byDay.size === 0) return null;

  // Number trades within each day chronologically.
  const numbered: { trade: QualifiedTrade; numberInSession: number }[] = [];
  for (const trades of byDay.values()) {
    trades.sort((a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime());
    trades.forEach((t, i) => numbered.push({ trade: t, numberInSession: i + 1 }));
  }
  if (numbered.length < 4) return null;

  const maxTradesPerDay = numbered.reduce((m, n) => Math.max(m, n.numberInSession), 0);

  // OLS slope of pnl ~ tradeNumberInSession, plus its significance test.
  // The t-stat of Pearson r equals the t-stat of the OLS slope, so we use
  // pearsonCorrelation as the regression-significance gate (|t| ≥ 2.0 ⇔
  // p < 0.05 at the sample sizes we care about).
  const xs = numbered.map((n) => n.numberInSession);
  const ys = numbered.map((n) => n.trade.aggregatePnl);
  const slope = simpleSlope(xs, ys);
  const slopeTest = pearsonCorrelation(xs, ys);

  // Try every cutoff N in [1, maxTradesPerDay-1] and pick the one that
  // maximises the average P&L of trades 1..N. The maximising N becomes the
  // recommended daily limit.
  let bestN = 1;
  let bestEarlyAvg = -Infinity;
  for (let n = 1; n < maxTradesPerDay; n++) {
    const earlyPnls = numbered.filter((t) => t.numberInSession <= n).map((t) => t.trade.aggregatePnl);
    if (earlyPnls.length === 0) continue;
    const avg = earlyPnls.reduce((a, b) => a + b, 0) / earlyPnls.length;
    if (avg > bestEarlyAvg) {
      bestEarlyAvg = avg;
      bestN = n;
    }
  }

  const earlyPnls = numbered.filter((t) => t.numberInSession <= bestN).map((t) => t.trade.aggregatePnl);
  const latePnls  = numbered.filter((t) => t.numberInSession >  bestN).map((t) => t.trade.aggregatePnl);
  if (earlyPnls.length < 2 || latePnls.length < 2) return null;

  const earlyAvg = earlyPnls.reduce((a, b) => a + b, 0) / earlyPnls.length;
  const lateAvg  = latePnls.reduce((a, b) => a + b, 0)  / latePnls.length;

  // No Welch test on early-vs-late at the snooped split — `bestN` was chosen
  // to maximise that very contrast, so a t-test there is a textbook
  // data-snooping false-positive generator. The slopeTest above is the
  // legitimate global fatigue test; early/late averages are descriptive only.

  // The "savings" is the sum of P&L from trades the user would have skipped
  // if they'd stopped at the cutoff. Negative late P&L → positive savings.
  const lateTotal = latePnls.reduce((a, b) => a + b, 0);
  const estimatedSavings = -lateTotal;

  return {
    slope,
    slopeTest,
    isSignificant: slopeTest.isSignificant,
    optimalCutoff: bestN,
    earlyAvg,
    lateAvg,
    estimatedSavings,
    maxTradesPerDay,
  };
}

function simpleSlope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 0;
  return (n * sxy - sx * sy) / denom;
}

function pending(testName: string, n: number): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
