'use client';

/**
 * PatternsSection — frontend for the ML pattern-discovery analytics.
 *
 * Reads from /api/analytics/ml (which serves cached results populated by
 * the ml-patterns insight detector during Compute Analytics). Renders three
 * sub-sections:
 *
 *   1. Cluster scatter plot — PC1 vs PC2, colored by cluster, winners
 *      filled / losers outlined. Cluster summary table beneath.
 *   2. Anomaly list — flagged trades with their top contributing features.
 *      Clicking a row opens the trade detail modal.
 *   3. Markov transition diagram — 2x2 W/L transition probabilities with
 *      independence-test significance badge.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import TradeDetailModal from '../trades/TradeDetailModal';
import { TOOLTIP_STYLE } from './types';
import { useJournal } from '../JournalContext';
import { useAuthFetch } from '@/lib/api-client';

// ── Types (mirror server output) ──────────────────────────────────────────

interface DistinctiveFeature {
  feature: string;
  clusterMean: number;
  overallMean: number;
}

interface ClusterInfo {
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

interface PcaPoint {
  x: number;
  y: number;
  cluster: number;
  positionId: string;
  isWinner: boolean;
}

interface ClusteringResult {
  k: number;
  silhouetteScore: number;
  clusters: ClusterInfo[];
  pcaData: PcaPoint[];
  pcaExplainedVariance: [number, number];
  lowQuality: boolean;
}

interface AnomalyFeatureContribution {
  feature: string;
  value: number;
  zScore: number;
}

interface AnomalyInfo {
  positionId: string;
  anomalyScore: number;
  topFeatures: AnomalyFeatureContribution[];
  position: { asset: string; pnl: number; entryTime: string };
}

interface AnomalyResult {
  anomalies: AnomalyInfo[];
  threshold: number;
  totalPositions: number;
  flat: boolean;
}

interface MarkovResult {
  transitionMatrix: { WW: number; WL: number; LW: number; LL: number };
  transitionProbabilities: {
    winAfterWin: number; lossAfterWin: number;
    winAfterLoss: number; lossAfterLoss: number;
  };
  independenceTest: {
    pValue: number;
    isSignificant: boolean;
    description: string;
    effectSize: number;
  };
  autocorrelation: number;
  interpretation: string;
  transitionCount: number;
  overallWinRate: number;
}

interface MlAnalyticsResponse {
  clustering: ClusteringResult | null;
  anomalies: AnomalyResult | null;
  markov: MarkovResult | null;
  computedAt: string | null;
}

// ── Cluster colors (8 distinct hues) ──────────────────────────────────────

const CLUSTER_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#84cc16', // lime
];

// ── Main component ────────────────────────────────────────────────────────

export default function PatternsSection() {
  // ML cache is stored per-journal — re-fetch when the active journal switches.
  const { journalId } = useJournal();
  const authFetch = useAuthFetch();
  const [data, setData] = useState<MlAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openPositionId, setOpenPositionId] = useState<string | null>(null);

  useEffect(() => {
    if (!journalId) return;
    setLoading(true);
    const p = new URLSearchParams({ journalId });
    authFetch(`/api/analytics/ml?${p}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [journalId, authFetch]);

  const handleCloseModal = useCallback(() => setOpenPositionId(null), []);

  if (loading) {
    return <div className="text-xs text-[#6e7681]">Loading patterns…</div>;
  }

  if (!data || (!data.clustering && !data.anomalies)) {
    return (
      <div className="text-xs text-[#6e7681]">
        No ML pattern data yet — analytics run automatically after trades are imported.
        Requires at least 50 closed trades.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {data.clustering && <ClusteringPanel result={data.clustering} onSelect={setOpenPositionId} />}
      {data.anomalies && <AnomalyPanel result={data.anomalies} onSelect={setOpenPositionId} />}

      {data.computedAt && (
        <div className="text-[10px] text-[#6e7681] pt-2 border-t border-[#21262d]">
          Computed {new Date(data.computedAt).toLocaleString()}
        </div>
      )}

      {openPositionId && (
        <TradeDetailModal
          positionId={openPositionId}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}

// ── Clustering panel ──────────────────────────────────────────────────────

function ClusteringPanel({
  result, onSelect,
}: {
  result: ClusteringResult;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (result.lowQuality || result.clusters.length === 0) {
    return (
      <div>
        <SectionHeader
          title="Trade Clusters"
          subtitle={`Silhouette ${result.silhouetteScore.toFixed(2)} — clusters not meaningful`}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
        />
        <div className="text-xs text-[#6e7681] bg-[#0d1117] border border-[#21262d] rounded p-4">
          No clear trading patterns detected yet. More trades with variety will help the algorithm find meaningful patterns.
        </div>
      </div>
    );
  }

  // Group PCA points by cluster for separate Scatter elements (so each gets its own color)
  const winnersByCluster: Record<number, PcaPoint[]> = {};
  const losersByCluster: Record<number, PcaPoint[]> = {};
  for (const pt of result.pcaData) {
    if (pt.isWinner) {
      (winnersByCluster[pt.cluster] ??= []).push(pt);
    } else {
      (losersByCluster[pt.cluster] ??= []).push(pt);
    }
  }

  return (
    <div>
      <SectionHeader
        title={`Trade Clusters (k=${result.k})`}
        subtitle={
          `Silhouette ${result.silhouetteScore.toFixed(2)} · ` +
          `PC1 ${(result.pcaExplainedVariance[0] * 100).toFixed(0)}% var · ` +
          `PC2 ${(result.pcaExplainedVariance[1] * 100).toFixed(0)}% var · ` +
          `winners filled, losers outlined`
        }
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      {collapsed ? null : (
      <div className="space-y-4">
      {/* Scatter plot */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded p-3 mb-4">
        <ResponsiveContainer width="100%" height={340}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke="#21262d" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="PC1"
              tick={{ fill: '#6e7681', fontSize: 11 }}
              axisLine={{ stroke: '#21262d' }}
              tickLine={false}
              label={{ value: 'PC1', position: 'insideBottom', offset: -5, fill: '#6e7681', fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="PC2"
              tick={{ fill: '#6e7681', fontSize: 11 }}
              axisLine={{ stroke: '#21262d' }}
              tickLine={false}
              label={{ value: 'PC2', angle: -90, position: 'insideLeft', fill: '#6e7681', fontSize: 11 }}
            />
            <ZAxis range={[40, 40]} />
            <Tooltip content={<ClusterTooltip clusters={result.clusters} />} cursor={{ strokeDasharray: '3 3' }} />
            {result.clusters.map((c) => {
              const color = CLUSTER_COLORS[c.id % CLUSTER_COLORS.length];
              return [
                winnersByCluster[c.id] && winnersByCluster[c.id].length > 0 && (
                  <Scatter
                    key={`w-${c.id}`}
                    name={`${c.label} (W)`}
                    data={winnersByCluster[c.id]}
                    fill={color}
                  />
                ),
                losersByCluster[c.id] && losersByCluster[c.id].length > 0 && (
                  <Scatter
                    key={`l-${c.id}`}
                    name={`${c.label} (L)`}
                    data={losersByCluster[c.id]}
                    fill="transparent"
                    stroke={color}
                    strokeWidth={1.5}
                  />
                ),
              ];
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Cluster summary table */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#161b22] text-[#6e7681]">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Cluster</th>
              <th className="text-right px-3 py-2 font-medium">Trades</th>
              <th className="text-right px-3 py-2 font-medium">Win Rate</th>
              <th className="text-right px-3 py-2 font-medium">Avg P&L</th>
              <th className="text-right px-3 py-2 font-medium">Total P&L</th>
              <th className="text-right px-3 py-2 font-medium">Avg Hold</th>
              <th className="text-left px-3 py-2 font-medium">Distinctive</th>
            </tr>
          </thead>
          <tbody>
            {result.clusters.map((c) => {
              const color = CLUSTER_COLORS[c.id % CLUSTER_COLORS.length];
              return (
                <tr key={c.id} className="border-t border-[#21262d]">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: color }} />
                      <span className="text-[#e6edf3]">{c.label}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-[#8b949e]">{c.tradeCount}</td>
                  <td className="px-3 py-2 text-right text-[#8b949e]">{c.winRate.toFixed(0)}%</td>
                  <td className={`px-3 py-2 text-right ${c.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${c.avgPnl.toFixed(2)}
                  </td>
                  <td className={`px-3 py-2 text-right ${c.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${c.totalPnl.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-right text-[#8b949e]">{formatHold(c.avgHoldTime)}</td>
                  <td className="px-3 py-2 text-[#6e7681]">
                    {c.distinctiveFeatures.map((f) => formatFeatureLabel(f.feature)).join(', ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
      )}
    </div>
  );
}

function ClusterTooltip({ active, payload, clusters }: any) {
  if (!active || !payload?.length) return null;
  const point: PcaPoint = payload[0].payload;
  const cluster = clusters.find((c: ClusterInfo) => c.id === point.cluster);
  return (
    <div style={TOOLTIP_STYLE.contentStyle as any} className="px-2 py-1.5">
      <div className="text-white font-medium text-[11px] mb-0.5">{cluster?.label ?? `Cluster ${point.cluster}`}</div>
      <div className={`text-[11px] ${point.isWinner ? 'text-green-400' : 'text-red-400'}`}>
        {point.isWinner ? 'Winner' : 'Loser'}
      </div>
    </div>
  );
}

// ── Anomaly panel ─────────────────────────────────────────────────────────

function AnomalyPanel({
  result, onSelect,
}: {
  result: AnomalyResult;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (result.flat || result.anomalies.length === 0) {
    return (
      <div>
        <SectionHeader
          title="Trades Flagged for Review"
          subtitle="None detected"
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
        />
        {!collapsed && (
          <div className="text-xs text-[#6e7681] bg-[#0d1117] border border-[#21262d] rounded p-4">
            Anomaly scores are evenly distributed across your {result.totalPositions} trades — no clear outliers.
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title={`${result.anomalies.length} Trades Flagged for Review`}
        subtitle={`Deviate significantly from your normal patterns · threshold ${result.threshold.toFixed(2)}`}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      {!collapsed && (
      <div className="bg-[#0d1117] border border-[#21262d] rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#161b22] text-[#6e7681]">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Asset</th>
              <th className="text-left px-3 py-2 font-medium">Entry</th>
              <th className="text-right px-3 py-2 font-medium">P&L</th>
              <th className="text-right px-3 py-2 font-medium">Score</th>
              <th className="text-left px-3 py-2 font-medium">Why it's unusual</th>
            </tr>
          </thead>
          <tbody>
            {result.anomalies.map((a) => {
              // Filter to notably unusual features (|z| > 1.5), sorted most unusual first
              const notableFeatures = [...a.topFeatures]
                .filter((f) => Math.abs(f.zScore) > 1.5)
                .sort((x, y) => Math.abs(y.zScore) - Math.abs(x.zScore));
              return (
                <tr
                  key={a.positionId}
                  className="border-t border-[#21262d] hover:bg-[#161b22] cursor-pointer transition-colors"
                  onClick={() => onSelect(a.positionId)}
                >
                  <td className="px-3 py-2 text-[#e6edf3]">{a.position.asset}</td>
                  <td className="px-3 py-2 text-[#6e7681]">
                    {a.position.entryTime ? new Date(a.position.entryTime).toLocaleDateString() : '—'}
                  </td>
                  <td className={`px-3 py-2 text-right ${a.position.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${a.position.pnl.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right text-amber-400">{a.anomalyScore.toFixed(2)}</td>
                  <td className="px-3 py-2 text-[#8b949e]">
                    {notableFeatures.length > 0
                      ? notableFeatures.map((f) => (
                          <span key={f.feature} className="block leading-snug">
                            {describeFeature(f.feature, f.zScore)}
                          </span>
                        ))
                      : <span className="text-[#6e7681]">Unusual overall pattern</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// ── Markov panel ──────────────────────────────────────────────────────────

function MarkovPanel({ result }: { result: MarkovResult }) {
  const isSig = result.independenceTest.isSignificant;
  const p = result.transitionProbabilities;
  const m = result.transitionMatrix;

  return (
    <div>
      <SectionHeader
        title="Outcome Serial Dependence"
        subtitle={`Markov W↔L transitions · ${result.transitionCount} transitions analyzed`}
      />

      <div className="bg-[#0d1117] border border-[#21262d] rounded p-4 space-y-4">
        {/* Significance badge */}
        <div className="flex items-center gap-2">
          {isSig ? (
            <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-medium bg-amber-500/15 text-amber-300">
              Serial Dependence Detected
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-medium bg-emerald-500/15 text-emerald-400">
              Outcomes Independent
            </span>
          )}
          <span className="text-[10px] text-[#6e7681]">
            χ² test: {result.independenceTest.description}
          </span>
        </div>

        {/* 2x2 transition grid */}
        <div className="grid grid-cols-3 gap-1 max-w-md text-[11px]">
          <div></div>
          <div className="text-center text-[#6e7681] uppercase tracking-widest text-[9px] py-1">→ Win</div>
          <div className="text-center text-[#6e7681] uppercase tracking-widest text-[9px] py-1">→ Loss</div>

          <div className="flex items-center justify-end pr-2 text-[#6e7681] uppercase tracking-widest text-[9px]">After Win</div>
          <TransitionCell prob={p.winAfterWin} count={m.WW} highlight={p.winAfterWin > result.overallWinRate + 0.05} />
          <TransitionCell prob={p.lossAfterWin} count={m.WL} />

          <div className="flex items-center justify-end pr-2 text-[#6e7681] uppercase tracking-widest text-[9px]">After Loss</div>
          <TransitionCell prob={p.winAfterLoss} count={m.LW} />
          <TransitionCell prob={p.lossAfterLoss} count={m.LL} highlight={p.lossAfterLoss > 1 - result.overallWinRate + 0.05} />
        </div>

        {/* Interpretation */}
        <p className="text-xs text-[#8b949e] leading-relaxed">{result.interpretation}</p>

        <div className="text-[10px] text-[#6e7681] flex gap-4">
          <span>Lag-1 autocorrelation: {result.autocorrelation.toFixed(3)}</span>
          <span>Overall win rate: {(result.overallWinRate * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}

function TransitionCell({
  prob, count, highlight = false,
}: {
  prob: number;
  count: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`bg-[#161b22] border rounded p-3 text-center ${highlight ? 'border-amber-500/50' : 'border-[#21262d]'}`}
    >
      <div className={`text-base font-semibold ${highlight ? 'text-amber-300' : 'text-[#e6edf3]'}`}>
        {(prob * 100).toFixed(0)}%
      </div>
      <div className="text-[9px] text-[#6e7681] mt-0.5">n={count}</div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
  collapsed,
  onToggle,
}: {
  title: string;
  subtitle?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left mb-3 group"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#6e7681] group-hover:text-[#c9d1d9] transition-colors">
            {collapsed ? '▶' : '▼'}
          </span>
          <h3 className="text-sm font-semibold text-white group-hover:text-[#c9d1d9] transition-colors">{title}</h3>
        </div>
        {subtitle && <p className="text-[11px] text-[#6e7681] mt-0.5 pl-4">{subtitle}</p>}
      </button>
    );
  }
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {subtitle && <p className="text-[11px] text-[#6e7681] mt-0.5">{subtitle}</p>}
    </div>
  );
}

/** Map a raw feature name + z-score to a human-readable explanation. */
function describeFeature(feature: string, zScore: number): string {
  const absZ = Math.abs(zScore).toFixed(1);
  switch (feature) {
    case 'totalSize':
      return `Unusually large position (${absZ}x normal variation)`;
    case 'holdTimeSeconds':
      return zScore > 0 ? 'Held much longer than usual' : 'Held much shorter than usual';
    case 'aggregatePnl':
    case 'pnl':
      return zScore < 0 ? 'Unusually large loss' : 'Unusually large gain';
    case 'tradesSinceLastLoss':
      return 'Long time since previous loss';
    case 'timeSinceLastTrade':
      return 'Unusual time gap since last trade';
    case 'entryHour':
      return 'Unusual entry time';
    case 'sizeVsAverage':
      return `Position ${absZ}x larger than your average`;
    case 'regimeEncoded':
      return 'Unusual market conditions';
    case 'entryDayOfWeek':
      return 'Unusual trading day';
    case 'rollingWinRate5':
      return zScore < 0 ? 'During a losing streak' : 'During a winning streak';
    case 'tradeTypeEncoded':
      return 'Different trade type than usual';
    default: {
      const label = feature.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
      return `${label} (${absZ}x normal)`;
    }
  }
}

function formatFeatureLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function formatHold(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

// ── Outcome Serial Dependence (Psychology tab) ────────────────────────────
// Standalone export — fetches the ML data and renders only the Markov panel.
// Lives here to share the type definitions and MarkovPanel component.

export function OutcomeSerialDependence() {
  const { journalId } = useJournal();
  const authFetch = useAuthFetch();
  const [markov, setMarkov] = useState<MarkovResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!journalId) return;
    setLoading(true);
    const p = new URLSearchParams({ journalId });
    authFetch(`/api/analytics/ml?${p}`)
      .then((r) => r.json())
      .then((d: MlAnalyticsResponse) => setMarkov(d.markov ?? null))
      .catch(() => setMarkov(null))
      .finally(() => setLoading(false));
  }, [journalId, authFetch]);

  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="text-xs text-[#6e7681]">Loading serial dependence…</div>
      </div>
    );
  }
  if (!markov) return null;

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
      <MarkovPanel result={markov} />
    </div>
  );
}
