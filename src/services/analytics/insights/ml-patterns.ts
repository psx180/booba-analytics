/**
 * ML pattern-discovery insight detector.
 *
 * Wraps three ML analyses (clustering, anomaly detection, Markov serial-
 * dependence) and emits up to three insight cards. Unlike the rule-based
 * detectors, these don't test pre-specified hypotheses — they discover
 * patterns the rules didn't anticipate.
 *
 * Statistical backing:
 *   - Clustering insight uses a synthetic StatisticalTest where the
 *     silhouette score plays the role of an effect size. p-values are
 *     mapped from silhouette quality so the BH FDR correction can still
 *     reason about significance in the same units as the rest of the
 *     pipeline.
 *   - Anomaly insight uses a similar synthetic test where the *spread* of
 *     the anomaly score distribution drives the p-value (flat distribution
 *     → no outliers → not significant).
 *   - Markov insight uses the real chi-squared independence test from
 *     statistics.ts directly.
 *
 * minimumPositions = 50 — ML methods need more data than rule-based tests.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import type { StatisticalTest } from '../types';
import { computeImpactScore } from '../statistics';
import { runClustering, type ClusteringResult } from '../ml/clustering';
import { runAnomalyDetection, type AnomalyResult } from '../ml/anomaly';
import { runMarkovAnalysis, type MarkovResult } from '../ml/markov';

const MIN_POSITIONS = 50;

export const mlPatternsDetector: InsightDetector = {
  name: 'ml-patterns',
  minimumPositions: MIN_POSITIONS,
  dimensions: [
    'aggregatePnl', 'holdTimeSeconds', 'totalSize',
    'entryHour', 'regimeAtEntry', 'tiltScore',
  ],

  detect(positions: Position[]): Insight[] {
    const closed = positions.filter(
      (p) => p.aggregatePnl != null && p.firstEntryTime != null,
    );
    if (closed.length < MIN_POSITIONS) return [];

    const insights: Insight[] = [];

    // ─── Clustering ───────────────────────────────────────────────────
    let clustering: ClusteringResult | null = null;
    try {
      clustering = runClustering(closed);
    } catch (err) {
      console.error('[ml-patterns] clustering failed:', err);
    }
    if (clustering) {
      insights.push(buildClusteringInsight(clustering, closed.length));
    }

    // ─── Anomaly detection ────────────────────────────────────────────
    let anomalies: AnomalyResult | null = null;
    try {
      anomalies = runAnomalyDetection(closed);
    } catch (err) {
      console.error('[ml-patterns] anomaly detection failed:', err);
    }
    if (anomalies) {
      insights.push(buildAnomalyInsight(anomalies, closed));
    }

    // ─── Markov ───────────────────────────────────────────────────────
    let markov: MarkovResult | null = null;
    try {
      markov = runMarkovAnalysis(closed);
    } catch (err) {
      console.error('[ml-patterns] markov failed:', err);
    }
    if (markov) {
      insights.push(buildMarkovInsight(markov, closed.length));
    }

    return insights;
  },
};

// ─── Clustering insight ────────────────────────────────────────────────────

function buildClusteringInsight(result: ClusteringResult, sampleSize: number): Insight {
  const test = silhouetteTest(result.silhouetteScore, sampleSize);

  if (result.lowQuality || result.clusters.length === 0) {
    return {
      module: 'ml-patterns-clustering',
      title: 'No Clear Trading Patterns Detected',
      description:
        `K-means with k=${result.k} produced clusters with silhouette score ` +
        `${result.silhouetteScore.toFixed(2)} (below 0.2 threshold). ` +
        `Your trades don't yet form distinct natural groups. More trades with variety will help the algorithm find meaningful patterns.`,
      severity: 'info',
      confidence: sampleSizeConfidence(sampleSize),
      affectedPositions: [],
      data: { clustering: result },
      statistics: [test],
      impactScore: 0,
      category: 'strategy',
      isSignificant: false,
      sampleSize,
    };
  }

  // Sort clusters by avg P&L to find best/worst
  const ranked = [...result.clusters].sort((a, b) => b.avgPnl - a.avgPnl);
  const best  = ranked[0];
  const worst = ranked[ranked.length - 1];

  // Estimated P&L improvement from doubling-down on best, halving worst
  const estimatedDelta = (best.avgPnl - worst.avgPnl) * worst.tradeCount * 0.5;

  const description =
    `Your trading naturally falls into ${result.k} patterns. ` +
    `${best.label}: ${best.winRate.toFixed(0)}% win rate, avg $${best.avgPnl.toFixed(0)}, ${best.tradeCount} trades. ` +
    `${worst.label}: ${worst.winRate.toFixed(0)}% win rate, avg $${worst.avgPnl.toFixed(0)}, ${worst.tradeCount} trades. ` +
    `Focusing on ${best.label.toLowerCase()} and reducing ${worst.label.toLowerCase()} would improve your P&L by approximately ` +
    `$${Math.round(Math.abs(estimatedDelta)).toLocaleString()}.`;

  const impactScore = computeImpactScore(estimatedDelta, test, 0.7);

  return {
    module: 'ml-patterns-clustering',
    title: `Trade DNA: ${result.k} Natural Patterns Discovered`,
    description,
    suggestion: worst.avgPnl < 0
      ? `The "${worst.label}" cluster is losing money on average. Review the trades in this cluster (open the patterns section) to understand what they share.`
      : undefined,
    severity: worst.avgPnl < 0 ? 'warning' : 'info',
    confidence: sampleSizeConfidence(sampleSize),
    affectedPositions: result.clusters.flatMap((c) => c.positionIds),
    data: { clustering: result },
    statistics: [test],
    impactScore,
    category: 'strategy',
    isSignificant: test.isSignificant,
    sampleSize,
  };
}

/**
 * Synthetic statistical test for clustering quality. The silhouette score
 * (0 to 1) is mapped to a p-value:
 *   ≥ 0.5  → p = 0.001  (strong cluster structure)
 *   ≥ 0.3  → p = 0.02   (moderate)
 *   ≥ 0.2  → p = 0.10   (weak / borderline)
 *   < 0.2  → p = 0.50   (effectively none)
 * The silhouette itself is used as the effect size so it surfaces in the
 * insight card alongside other detector tests.
 */
function silhouetteTest(silhouette: number, n: number): StatisticalTest {
  let pValue: number;
  if (silhouette >= 0.5)      pValue = 0.001;
  else if (silhouette >= 0.3) pValue = 0.02;
  else if (silhouette >= 0.2) pValue = 0.10;
  else                         pValue = 0.50;

  const isSignificant = pValue < 0.05;
  const quality =
    silhouette >= 0.5 ? 'strong cluster structure' :
    silhouette >= 0.3 ? 'moderate cluster structure' :
    silhouette >= 0.2 ? 'weak cluster structure' :
                        'no meaningful cluster structure';

  return {
    testName: 'silhouette_quality',
    pValue,
    effectSize: silhouette,
    sampleSizeA: n,
    sampleSizeB: 0,
    isSignificant,
    description: `Silhouette ${silhouette.toFixed(2)} — ${quality} (N=${n})`,
  };
}

// ─── Anomaly insight ───────────────────────────────────────────────────────

function buildAnomalyInsight(result: AnomalyResult, positions: Position[]): Insight {
  const flaggedIds = new Set(result.anomalies.map((a) => a.positionId));
  const flagged = positions.filter((p) => flaggedIds.has(p.id));
  const normal  = positions.filter((p) => !flaggedIds.has(p.id) && p.aggregatePnl != null);

  const flaggedPnls = flagged.map((p) => p.aggregatePnl ?? 0);
  const normalPnls  = normal.map((p) => p.aggregatePnl ?? 0);

  const avgFlaggedPnl = mean(flaggedPnls);
  const avgNormalPnl  = mean(normalPnls);
  const totalFlaggedPnl = flaggedPnls.reduce((a, b) => a + b, 0);

  // Top features across all flagged trades
  const featureCounts: Record<string, number> = {};
  for (const a of result.anomalies) {
    for (const f of a.topFeatures) {
      featureCounts[f.feature] = (featureCounts[f.feature] ?? 0) + 1;
    }
  }
  const topFeatures = Object.entries(featureCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([f]) => formatFeatureName(f));

  const test = anomalyTest(result, positions.length);

  if (result.flat || result.anomalies.length === 0) {
    return {
      module: 'ml-patterns-anomaly',
      title: 'No Outlier Trades Detected',
      description:
        `Anomaly scores are evenly distributed across your ${result.totalPositions} trades — ` +
        `there are no clear outliers in your trading behavior. Your trades are consistent.`,
      severity: 'info',
      confidence: sampleSizeConfidence(positions.length),
      affectedPositions: [],
      data: { anomalies: result },
      statistics: [test],
      impactScore: 0,
      category: 'strategy',
      isSignificant: false,
      sampleSize: positions.length,
    };
  }

  const description =
    `Found ${result.anomalies.length} trades that significantly deviate from your normal behavior. ` +
    `These trades have an average P&L of $${avgFlaggedPnl.toFixed(0)} ` +
    `(vs $${avgNormalPnl.toFixed(0)} for normal trades). ` +
    (topFeatures.length > 0
      ? `Most common anomaly features: ${topFeatures.join(', ')}. `
      : '') +
    `Review these trades to determine if they represent mistakes to avoid or opportunities to seek.`;

  const impactScore = computeImpactScore(totalFlaggedPnl, test, 0.7);

  return {
    module: 'ml-patterns-anomaly',
    title: `${result.anomalies.length} Unusual Trades Detected`,
    description,
    suggestion: avgFlaggedPnl < avgNormalPnl
      ? 'Anomalous trades are underperforming on average — they likely represent mistakes worth understanding before they recur.'
      : 'Anomalous trades are outperforming on average — these may represent opportunities worth replicating intentionally.',
    severity: avgFlaggedPnl < avgNormalPnl && totalFlaggedPnl < -100 ? 'warning' : 'info',
    confidence: sampleSizeConfidence(positions.length),
    affectedPositions: Array.from(flaggedIds),
    data: { anomalies: result },
    statistics: [test],
    impactScore,
    category: 'strategy',
    isSignificant: test.isSignificant,
    sampleSize: positions.length,
  };
}

/**
 * Synthetic test for anomaly detection. p-value is driven by whether the
 * score distribution is flat (no real outliers) and the magnitude of
 * variation in scores.
 */
function anomalyTest(result: AnomalyResult, n: number): StatisticalTest {
  if (result.flat || result.anomalies.length === 0) {
    return {
      testName: 'anomaly_score_distribution',
      pValue: 0.5,
      effectSize: 0,
      sampleSizeA: n,
      sampleSizeB: 0,
      isSignificant: false,
      description: `Anomaly score distribution is flat (N=${n}) — no clear outliers`,
    };
  }
  // Real outliers exist — significance depends on how separated they are
  const effect = Math.min(1, result.threshold);
  const pValue = effect > 0.5 ? 0.005 : 0.03;
  return {
    testName: 'anomaly_score_distribution',
    pValue,
    effectSize: effect,
    sampleSizeA: result.anomalies.length,
    sampleSizeB: n - result.anomalies.length,
    isSignificant: true,
    description: `${result.anomalies.length} of ${n} trades flagged at threshold ${result.threshold.toFixed(2)}`,
  };
}

// ─── Markov insight ────────────────────────────────────────────────────────

function buildMarkovInsight(result: MarkovResult, sampleSize: number): Insight {
  const test = result.independenceTest;
  const isSig = test.isSignificant;

  // Impact estimate: if loss-after-loss is elevated, count the "extra" losses
  const baselineLossRate = 1 - result.overallWinRate;
  const excessLossLoss = Math.max(0, result.transitionProbabilities.lossAfterLoss - baselineLossRate);
  const lossesAfterLoss = result.transitionMatrix.LL + result.transitionMatrix.LW;
  // Rough dollar impact: extra losses × average loss magnitude (we don't know the latter
  // here so weight it implicitly via the proportion). Use a coarse but consistent metric.
  const dollarImpact = excessLossLoss * lossesAfterLoss * 50;

  const impactScore = computeImpactScore(dollarImpact, test, 0.4);

  return {
    module: 'ml-patterns-markov',
    title: isSig ? 'Serial Dependence Detected' : 'Outcome Independence Analysis',
    description: result.interpretation,
    suggestion: isSig
      ? 'After a losing trade, pause briefly before entering the next one. The data shows your losses cluster more than chance — break the chain.'
      : undefined,
    severity: isSig ? 'warning' : 'info',
    confidence: sampleSizeConfidence(sampleSize),
    affectedPositions: [],
    data: { markov: result },
    statistics: [test],
    impactScore,
    category: 'strategy',
    isSignificant: isSig,
    sampleSize,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function formatFeatureName(name: string): string {
  // camelCase → Title Case With Spaces
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
