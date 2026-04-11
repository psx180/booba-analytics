/**
 * K-means clustering of trade feature vectors.
 *
 * Discovers natural trading "archetypes" — groups of trades that share
 * similar characteristics. The trader doesn't predefine the categories; the
 * algorithm finds them. We sweep k=3,4,5 and pick the k with the best
 * silhouette score, then run PCA so the result can be plotted in 2D.
 *
 * Crucially we exclude `isWinner` from the clustering features. We want to
 * discover patterns that *predict* win/loss, not cluster trades by their
 * outcome label (which would be circular).
 */

import { kmeans } from 'ml-kmeans';
import { PCA } from 'ml-pca';
import type { Position } from '../types';
import {
  extractFeatures,
  normalizeFeatures,
  NUMERIC_FEATURE_NAMES,
  type TradeFeatureVector,
  type NormalizedFeatures,
} from './features';

// ─── Output types ──────────────────────────────────────────────────────────

export interface DistinctiveFeature {
  feature: string;
  clusterMean: number;
  overallMean: number;
}

export interface ClusterInfo {
  id: number;
  label: string;
  tradeCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  avgHoldTime: number;
  avgTiltScore: number;
  dominantRegime: string;
  dominantTradeType: string;
  distinctiveFeatures: DistinctiveFeature[];
  positionIds: string[];
}

export interface PcaPoint {
  x: number;
  y: number;
  cluster: number;
  positionId: string;
  isWinner: boolean;
}

export interface ClusteringResult {
  k: number;
  silhouetteScore: number;
  clusters: ClusterInfo[];
  pcaData: PcaPoint[];
  pcaExplainedVariance: [number, number];
  /** True if silhouette is too low to be meaningful (< 0.2). */
  lowQuality: boolean;
}

// ─── Configuration ─────────────────────────────────────────────────────────

/**
 * Features used for clustering. NOT including `isWinner` — we want to
 * discover patterns that predict win/loss, not cluster on the label itself.
 * `pnl` is included because pattern-of-magnitude matters for archetypes.
 */
const CLUSTER_FEATURES = [
  'holdTimeSeconds',
  'totalSize',
  'entryHour',
  'regimeEncoded',
  'tiltScore',
  'sizeVsAverage',
  'pnl',
] as const;

const REGIME_LABELS: Record<number, string> = {
  0: 'trending_low_vol',
  1: 'trending_high_vol',
  2: 'ranging_low_vol',
  3: 'ranging_high_vol',
  4: 'transitional',
};

const TRADE_TYPE_LABELS: Record<number, string> = {
  0: 'scalp',
  1: 'directional',
  2: 'scaled_directional',
  3: 'carry_trade',
  4: 'market_making',
  5: 'liquidation_acquisition',
};

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Run clustering on a list of closed positions. Returns null when there are
 * fewer than 15 positions (k-means with k=5 needs at least k*3 points to be
 * meaningful).
 */
export function runClustering(positions: Position[]): ClusteringResult | null {
  const features = extractFeatures(positions);
  if (features.length < 15) return null;

  const normalized = normalizeFeatures(features);

  // Subset the normalized matrix to the clustering features only
  const clusterCols = CLUSTER_FEATURES.map(
    (name) => NUMERIC_FEATURE_NAMES.indexOf(name as any),
  );
  const data: number[][] = normalized.normalized.map((row) =>
    clusterCols.map((c) => row[c]),
  );

  // Sweep k=3,4,5 and pick the best by silhouette
  const candidates: { k: number; clusters: number[]; silhouette: number }[] = [];
  for (const k of [3, 4, 5]) {
    if (data.length < k * 2) continue;
    try {
      const result = kmeans(data, k, { seed: 42, initialization: 'kmeans++', maxIterations: 100 });
      const sil = silhouetteScore(data, result.clusters, k);
      candidates.push({ k, clusters: result.clusters, silhouette: sil });
    } catch (err) {
      console.error(`[ml/clustering] k=${k} failed:`, err);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.silhouette - a.silhouette);
  const best = candidates[0];

  // PCA → 2D for visualization (use full normalized matrix, not the subset,
  // so the projection captures the broader feature space).
  let pcaData: PcaPoint[] = [];
  let pcaVar: [number, number] = [0, 0];
  try {
    const pca = new PCA(normalized.normalized, { center: false, scale: false });
    const projected = pca.predict(normalized.normalized, { nComponents: 2 }).to2DArray();
    const explained = pca.getExplainedVariance();
    pcaVar = [explained[0] ?? 0, explained[1] ?? 0];
    pcaData = projected.map((row, i) => ({
      x: row[0],
      y: row[1],
      cluster: best.clusters[i],
      positionId: normalized.vectors[i].positionId,
      isWinner: normalized.vectors[i].isWinner,
    }));
  } catch (err) {
    console.error('[ml/clustering] PCA failed:', err);
  }

  // Build per-cluster stats from the *raw* (un-normalized) feature vectors
  const clusters = buildClusterInfo(best.clusters, best.k, normalized);

  const lowQuality = best.silhouette < 0.2;
  if (lowQuality) {
    console.log(
      `[ml/clustering] silhouette=${best.silhouette.toFixed(3)} below 0.2 — clusters not meaningful`,
    );
  } else {
    console.log(
      `[ml/clustering] picked k=${best.k} silhouette=${best.silhouette.toFixed(3)}`,
    );
  }

  return {
    k: best.k,
    silhouetteScore: Math.round(best.silhouette * 1000) / 1000,
    clusters,
    pcaData,
    pcaExplainedVariance: pcaVar,
    lowQuality,
  };
}

// ─── Cluster info builder ──────────────────────────────────────────────────

function buildClusterInfo(
  assignments: number[],
  k: number,
  normalized: NormalizedFeatures,
): ClusterInfo[] {
  const vectors = normalized.vectors;
  const overallMeans = normalized.means;

  const clusters: ClusterInfo[] = [];

  for (let cid = 0; cid < k; cid++) {
    const memberIndices: number[] = [];
    for (let i = 0; i < assignments.length; i++) {
      if (assignments[i] === cid) memberIndices.push(i);
    }
    if (memberIndices.length === 0) continue;

    const members = memberIndices.map((i) => vectors[i]);

    const winners = members.filter((m) => m.isWinner).length;
    const totalPnl = members.reduce((s, m) => s + m.pnl, 0);
    const avgPnl   = totalPnl / members.length;
    const avgHold  = members.reduce((s, m) => s + m.holdTimeSeconds, 0) / members.length;
    const avgTilt  = members.reduce((s, m) => s + m.tiltScore, 0) / members.length;

    // Dominant regime / trade type
    const regimeCounts: Record<number, number> = {};
    const ttCounts: Record<number, number> = {};
    for (const m of members) {
      regimeCounts[m.regimeEncoded] = (regimeCounts[m.regimeEncoded] ?? 0) + 1;
      ttCounts[m.tradeTypeEncoded]  = (ttCounts[m.tradeTypeEncoded] ?? 0) + 1;
    }
    const dominantRegime = pickDominant(regimeCounts, REGIME_LABELS, 'transitional');
    const dominantTradeType = pickDominant(ttCounts, TRADE_TYPE_LABELS, 'directional');

    // Per-feature cluster mean (raw scale)
    const clusterMeans: number[] = new Array(NUMERIC_FEATURE_NAMES.length).fill(0);
    for (const i of memberIndices) {
      const row = featureRow(vectors[i]);
      for (let j = 0; j < row.length; j++) clusterMeans[j] += row[j];
    }
    for (let j = 0; j < clusterMeans.length; j++) {
      clusterMeans[j] /= memberIndices.length;
    }

    // Distinctive features = top 3 by absolute z-score difference vs overall
    // (use stdev so the comparison is scale-invariant)
    const distinct: { feature: string; clusterMean: number; overallMean: number; z: number }[] = [];
    for (let j = 0; j < NUMERIC_FEATURE_NAMES.length; j++) {
      const stdev = normalized.stdevs[j];
      if (stdev < 1e-12) continue;
      const z = Math.abs(clusterMeans[j] - overallMeans[j]) / stdev;
      distinct.push({
        feature: NUMERIC_FEATURE_NAMES[j],
        clusterMean: clusterMeans[j],
        overallMean: overallMeans[j],
        z,
      });
    }
    distinct.sort((a, b) => b.z - a.z);
    const distinctiveFeatures: DistinctiveFeature[] = distinct.slice(0, 3).map((d) => ({
      feature: d.feature,
      clusterMean: round(d.clusterMean),
      overallMean: round(d.overallMean),
    }));

    const label = autoLabel(
      avgHold,
      members.reduce((s, m) => s + m.entryHour, 0) / members.length,
      avgTilt,
      members.reduce((s, m) => s + m.sizeVsAverage, 0) / members.length,
      dominantRegime,
      dominantTradeType,
    );

    clusters.push({
      id: cid,
      label,
      tradeCount: members.length,
      winRate: Math.round((winners / members.length) * 1000) / 10,
      avgPnl: round(avgPnl),
      totalPnl: round(totalPnl),
      avgHoldTime: Math.round(avgHold),
      avgTiltScore: Math.round(avgTilt * 100) / 100,
      dominantRegime,
      dominantTradeType,
      distinctiveFeatures,
      positionIds: members.map((m) => m.positionId),
    });
  }

  return clusters;
}

// ─── Auto-labelling ────────────────────────────────────────────────────────

function autoLabel(
  avgHoldSeconds: number,
  avgEntryHour: number,
  avgTilt: number,
  avgSizeRatio: number,
  dominantRegime: string,
  dominantTradeType: string,
): string {
  const parts: string[] = [];

  // Tilt qualifier always wins
  if (avgTilt > 0.5) parts.push('High-Tilt');
  else if (avgSizeRatio > 1.5) parts.push('Oversized');
  else if (avgSizeRatio < 0.6) parts.push('Small');

  // Hold-time bucket
  if (avgHoldSeconds < 15 * 60) parts.push('Quick');
  else if (avgHoldSeconds < 4 * 60 * 60) parts.push('Intraday');
  else if (avgHoldSeconds < 24 * 60 * 60) parts.push('Swing');
  else parts.push('Long-Hold');

  // Time-of-day
  if (avgEntryHour < 6) parts.push('Overnight');
  else if (avgEntryHour < 12) parts.push('Morning');
  else if (avgEntryHour < 17) parts.push('Afternoon');
  else parts.push('Evening');

  // Trade type / regime tail
  if (dominantTradeType === 'carry_trade') parts.push('Carry');
  else if (dominantTradeType === 'market_making') parts.push('Market-Making');
  else if (dominantTradeType === 'liquidation_acquisition') parts.push('Auction');
  else if (dominantRegime === 'trending_high_vol' || dominantRegime === 'trending_low_vol') {
    parts.push('Trend');
  } else if (dominantRegime === 'ranging_high_vol' || dominantRegime === 'ranging_low_vol') {
    parts.push('Range');
  } else {
    parts.push('Trades');
  }

  return parts.join(' ');
}

// ─── Silhouette score ──────────────────────────────────────────────────────

/**
 * Mean silhouette score across all points. For each point i:
 *   a(i) = mean distance to other points in its own cluster
 *   b(i) = mean distance to points in the nearest *other* cluster
 *   s(i) = (b - a) / max(a, b)
 * Silhouette in [-1, 1]; > 0.5 strong, > 0.25 weak, < 0.2 effectively none.
 *
 * For ~300-trade datasets this O(n²) implementation is fine.
 */
function silhouetteScore(data: number[][], assignments: number[], k: number): number {
  const n = data.length;
  if (n < 2 || k < 2) return 0;

  // Group indices by cluster
  const groups: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) groups[assignments[i]].push(i);

  let sum = 0;
  let counted = 0;

  for (let i = 0; i < n; i++) {
    const own = assignments[i];
    if (groups[own].length <= 1) {
      // Singleton clusters contribute 0
      continue;
    }

    // Mean distance to own cluster (excluding self)
    let a = 0;
    for (const j of groups[own]) {
      if (j === i) continue;
      a += euclidean(data[i], data[j]);
    }
    a /= (groups[own].length - 1);

    // Min mean distance to other clusters
    let b = Infinity;
    for (let cid = 0; cid < k; cid++) {
      if (cid === own) continue;
      if (groups[cid].length === 0) continue;
      let d = 0;
      for (const j of groups[cid]) d += euclidean(data[i], data[j]);
      d /= groups[cid].length;
      if (d < b) b = d;
    }
    if (!isFinite(b)) continue;

    const s = (b - a) / Math.max(a, b);
    if (isFinite(s)) {
      sum += s;
      counted++;
    }
  }

  return counted > 0 ? sum / counted : 0;
}

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function featureRow(v: TradeFeatureVector): number[] {
  return [
    v.pnl,
    v.holdTimeSeconds,
    v.totalSize,
    v.entryHour,
    v.entryDayOfWeek,
    v.regimeEncoded,
    v.tradeTypeEncoded,
    v.tiltScore,
    v.tradesSinceLastLoss,
    v.rollingWinRate5,
    v.sizeVsAverage,
    v.timeSinceLastTrade,
  ];
}

function pickDominant(
  counts: Record<number, number>,
  labels: Record<number, string>,
  fallback: string,
): string {
  let bestId = -1;
  let bestCount = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) {
      bestCount = v;
      bestId = Number(k);
    }
  }
  return labels[bestId] ?? fallback;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
