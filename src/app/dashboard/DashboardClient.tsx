'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import EquityCurve, { EquityPoint, TradeMeta, REGIME_LABELS } from './EquityCurve';
import UnderwaterCurve, { UnderwaterPoint } from './UnderwaterCurve';
import OpenPositions from './OpenPositions';
import LiveToast, { type Toast } from './LiveToast';
import { useJournal } from '../JournalContext';
import { useLive } from '../LiveContext';
import { useAuthFetch } from '@/lib/api-client';
import BoobaAvatar from '@/app/components/booba/BoobaAvatar';
import BoobaChat from '@/app/components/booba/BoobaChat';
import { computeHealthScore } from '@/app/components/booba/computeHealthScore';
import { getContextualMessage } from '@/app/components/booba/getContextualMessage';
import TradeAnnotationPopup, { type PopupPosition } from '@/app/components/trade-popup/TradeAnnotationPopup';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PerformanceData {
  tradeCount: number;
  winRate: number;        // fraction 0-1
  lossRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  profitFactor: number;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
  avgTiltScore?: number;      // 0-1, averaged over positions with computed tiltScore
  tiltCoverage?: number;      // 0-1, fraction of positions with a score
  tiltEpisodeCount?: number;
}

interface PerformanceResult {
  name: string;
  data: PerformanceData;
  breakdowns?: { regime: Record<string, PerformanceData> };
  // Advanced summary fields appended by /api/analytics/summary
  eloResult?: EloResult;
  entropyResult?: EntropyResult;
  xpnlLuckScore?: number;
  xpnlResult?: XpnlSummary;
  equityCurveConsistency?: number;
  wartResult?: WartResult;
}

interface WartAxis {
  score: number;
  method: string;
  details: string;
}

interface WartResult {
  composite: number;
  tier: string;
  axes: {
    entry: WartAxis;
    exit: WartAxis;
    risk: WartAxis;
    timing: WartAxis;
    discipline: WartAxis;
  };
  weightedScore: number;
  improvements: string[];
  tradeCount: number;
}

interface EloResult {
  currentElo: number;
  tier: string;
  peakElo: number;
  peakDate: string | null;
  eloSeries: { date: string; elo: number }[];
  conditionDifficulty: { condition: string; elo: number }[];
  recentTrend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

interface EntropyResult {
  compositeScore: number;
  dimensions: { name: string; entropy: number; normalizedEntropy: number; maxEntropy: number }[];
  conditionalEntropy: number;
  rollingSeries: { date: string; score: number }[];
  trend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

interface XpnlSummary {
  positions: { positionId: string; actualPnl: number; xpnl: number; residual: number }[];
  cumulativeSeries: { date: string; actualCumPnl: number; xpnlCumPnl: number }[];
  luckScore: number;
  r2: number;
}

interface EquityCurvePoint {
  date: string;
  value: number;
  cumulativePnl: number;
  regime: string;
  positionId: string;
}

interface EquityCurveResult {
  name: string;
  data: {
    tradeCount: number;
    finalPnl: number;
    maxDrawdown?: number;
    maxDrawdownPct?: number;
    maxDrawdownDuration?: number;
    currentDrawdown?: number;
    currentDrawdownPct?: number;
    underwaterSeries?: UnderwaterPoint[];
  };
  series: EquityCurvePoint[];
}

interface Insight {
  module: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;
  suggestion?: string;
  data: Record<string, any>;
  impactScore?: number;
  category?: string;
  isSignificant?: boolean;
}

// ── Module-level dashboard cache ─────────────────────────────────────────────
// Persists across React component mounts within the same browser session.
// Key: `${journalId}|${regime ?? ''}` — isolated per journal and regime filter.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface DashboardCacheEntry {
  timestamp: number;
  performance: PerformanceData | null;
  equityCurve: EquityPoint[];
  tradeMetas: TradeMeta[];
  insights: Insight[];
  lastComputedAt: string | null;
  eloResult: EloResult | null;
  entropyResult: EntropyResult | null;
  equityConsistency: number | null;
  xpnlSummary: XpnlSummary | null;
  wartResult: WartResult | null;
  untaggedPositionCount: number;
  underwaterSeries: UnderwaterPoint[];
  drawdownStats: {
    maxDrawdown: number;
    maxDrawdownPct: number;
    currentDrawdown: number;
    currentDrawdownPct: number;
  } | null;
}

const dashboardCache = new Map<string, DashboardCacheEntry>();

// ── Constants ─────────────────────────────────────────────────────────────────

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending ↑V', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging ↑V',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

const FILTER_REGIMES = [
  { key: 'trending_low_vol',  label: 'Trending' },
  { key: 'trending_high_vol', label: 'Trending ↑Vol' },
  { key: 'ranging_low_vol',   label: 'Ranging' },
  { key: 'ranging_high_vol',  label: 'Ranging ↑Vol' },
  { key: 'transitional',      label: 'Transitional' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pnlColor(v: number) {
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function formatPnl(v: number) {
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
}

function formatPercent(fraction: number) {
  return `${(fraction * 100).toFixed(1)}%`;
}

// Tilt score shown on a 0-100 scale with a green/amber/red band.
function tiltColor(score0to100: number): string {
  if (score0to100 < 30) return 'text-green-400';
  if (score0to100 < 60) return 'text-amber-400';
  return 'text-red-400';
}

function eloColor(elo: number): string {
  if (elo >= 1800) return 'text-purple-400';
  if (elo >= 1600) return 'text-blue-400';
  if (elo >= 1400) return 'text-green-400';
  if (elo >= 1200) return 'text-amber-400';
  return 'text-red-400';
}

function disciplineColor(score: number): string {
  if (score >= 65) return 'text-green-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

function consistencyColor(r2: number): string {
  if (r2 >= 0.7) return 'text-green-400';
  if (r2 >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

function wartColor(composite: number): string {
  if (composite >=  1) return 'text-green-400';
  if (composite >= -0.5) return 'text-amber-400';
  return 'text-red-400';
}

function formatWart(c: number): string {
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}`;
}

/**
 * Synthesises a "drawdown %" from the current unrealized P&L on open
 * positions so Booba's health score reflects open-trade pain before any
 * realized loss shows up in the equity curve. Returns negative when
 * positions are underwater, null when there's no unrealized data yet.
 */
function liveUnrealizedDrawdownPct(
  rows: { unrealizedPnl: number; entryPrice: number; amount: number }[],
): number | undefined {
  if (!rows.length) return undefined;
  const totalNotional = rows.reduce((s, r) => s + r.entryPrice * r.amount, 0);
  if (totalNotional === 0) return undefined;
  const totalPnl = rows.reduce((s, r) => s + r.unrealizedPnl, 0);
  return (totalPnl / totalNotional) * 100;
}

function trendArrow(trend: 'improving' | 'declining' | 'stable'): string {
  if (trend === 'improving') return '↑';
  if (trend === 'declining') return '↓';
  return '→';
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-[#6e7681] mt-0.5">{sub}</div>}
    </div>
  );
}


// ── Main Component ────────────────────────────────────────────────────────────

export default function DashboardClient() {
  // Active wallet + journal id flow in from JournalContext (the wallet is
  // sourced from Privy or the dev bypass — never from URL params). Every
  // API call appends them via buildParams so the dashboard renders
  // journal-scoped analytics. Switching journal triggers fetchData.
  const { journalId, buildParams } = useJournal();
  const authFetch = useAuthFetch();
  const [chatOpen, setChatOpen] = useState(false);
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [tradeMetas, setTradeMetas] = useState<TradeMeta[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [activeRegime, setActiveRegime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastComputedAt, setLastComputedAt] = useState<string | null>(null);
  // Onboarding state — tracks the first-time import flow.
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [importDone, setImportDone] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  // Advanced analytics
  const [eloResult, setEloResult] = useState<EloResult | null>(null);
  const [entropyResult, setEntropyResult] = useState<EntropyResult | null>(null);
  const [equityConsistency, setEquityConsistency] = useState<number | null>(null);
  const [xpnlSummary, setXpnlSummary] = useState<XpnlSummary | null>(null);
  const [showXpnlOverlay, setShowXpnlOverlay] = useState(true);
  const [wartResult, setWartResult] = useState<WartResult | null>(null);
  const [untaggedPositionCount, setUntaggedPositionCount] = useState<number>(0);
  const [underwaterSeries, setUnderwaterSeries] = useState<UnderwaterPoint[]>([]);
  const [drawdownStats, setDrawdownStats] = useState<{
    maxDrawdown: number;
    maxDrawdownPct: number;
    currentDrawdown: number;
    currentDrawdownPct: number;
  } | null>(null);

  // ── Live websocket state ──
  const { openPositions, initialPositions, lastTrade, lastClosedTrade, connected, lastSyncImport } = useLive();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [livePopup, setLivePopup] = useState<PopupPosition | null>(null);
  const [liveHealthBoost, setLiveHealthBoost] = useState(0);
  const lastTradeSeenRef = useRef<number>(0);
  const lastClosedSeenRef = useRef<number>(0);
  const hasMountSynced = useRef(false);
  const lastSyncImportRef = useRef(lastSyncImport);

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5_000);
  }, []);

  // doFetch — raw network fetch + state apply. isBackground=true skips the loading spinner.
  const doFetch = useCallback(
    async (regime: string | null, isBackground = false) => {
      const cacheKey = `${journalId}|${regime ?? ''}`;
      try {
        const params = buildParams(regime ? { regime } : undefined);
        const equityParams = buildParams({
          ...(regime ? { regime } : {}),
          withXpnl: 'true',
        });
        const insightsParams = buildParams();

        const [summaryRes, equityRes, insightsRes, untaggedRes] = await Promise.all([
          authFetch(`/api/analytics/summary?${params}`),
          authFetch(`/api/analytics/equity-curve?${equityParams}`),
          authFetch(`/api/analytics/insights?${insightsParams}`),
          authFetch('/api/positions/untagged-count'),
        ]);

        const [summaryData, equityData, insightsData, untaggedData] = await Promise.all([
          summaryRes.json() as Promise<PerformanceResult>,
          equityRes.json() as Promise<EquityCurveResult & { xpnl?: XpnlSummary }>,
          insightsRes.json() as Promise<{ insights: Insight[]; lastComputedAt?: string | null }>,
          untaggedRes.json() as Promise<{ count: number }>,
        ]);

        const entry: DashboardCacheEntry = {
          timestamp: Date.now(),
          performance: summaryData.data ?? null,
          eloResult: summaryData.eloResult ?? null,
          entropyResult: summaryData.entropyResult ?? null,
          equityConsistency: summaryData.equityCurveConsistency ?? null,
          xpnlSummary: equityData.xpnl ?? summaryData.xpnlResult ?? null,
          wartResult: summaryData.wartResult ?? null,
          equityCurve: (equityData.series ?? []).map((p) => ({
            date: p.date,
            cumulativePnl: p.cumulativePnl,
          })),
          tradeMetas: (equityData.series ?? []).map((p) => ({
            date: p.date,
            regimeAtEntry: p.regime,
          })),
          underwaterSeries: equityData.data?.underwaterSeries ?? [],
          drawdownStats: equityData.data?.maxDrawdown != null
            ? {
                maxDrawdown:        equityData.data.maxDrawdown,
                maxDrawdownPct:     equityData.data.maxDrawdownPct ?? 0,
                currentDrawdown:    equityData.data.currentDrawdown ?? 0,
                currentDrawdownPct: equityData.data.currentDrawdownPct ?? 0,
              }
            : null,
          insights: insightsData.insights ?? [],
          lastComputedAt: insightsData.lastComputedAt ?? null,
          untaggedPositionCount: untaggedData.count ?? 0,
        };

        dashboardCache.set(cacheKey, entry);

        setPerformance(entry.performance);
        setEloResult(entry.eloResult);
        setEntropyResult(entry.entropyResult);
        setEquityConsistency(entry.equityConsistency);
        setXpnlSummary(entry.xpnlSummary);
        setWartResult(entry.wartResult);
        setEquityCurve(entry.equityCurve);
        setTradeMetas(entry.tradeMetas);
        setUnderwaterSeries(entry.underwaterSeries);
        setDrawdownStats(entry.drawdownStats);
        setInsights(entry.insights);
        setLastComputedAt(entry.lastComputedAt);
        setUntaggedPositionCount(entry.untaggedPositionCount);
      } finally {
        if (!isBackground) setLoading(false);
      }
    },
    [journalId, buildParams, authFetch],
  );

  // fetchData — cache-aware wrapper around doFetch.
  // On cache hit: populates state immediately, then refreshes in the background.
  // On cache miss: shows loading spinner, fetches, caches result.
  const fetchData = useCallback(
    async (regime: string | null) => {
      const cacheKey = `${journalId}|${regime ?? ''}`;
      const cached = dashboardCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        setPerformance(cached.performance);
        setEloResult(cached.eloResult);
        setEntropyResult(cached.entropyResult);
        setEquityConsistency(cached.equityConsistency);
        setXpnlSummary(cached.xpnlSummary);
        setWartResult(cached.wartResult);
        setEquityCurve(cached.equityCurve);
        setTradeMetas(cached.tradeMetas);
        setUnderwaterSeries(cached.underwaterSeries);
        setDrawdownStats(cached.drawdownStats);
        setInsights(cached.insights);
        setLastComputedAt(cached.lastComputedAt);
        setUntaggedPositionCount(cached.untaggedPositionCount);
        setLoading(false);
        // Background refresh — no spinner, silently updates state when done
        doFetch(regime, true).catch(console.error);
        return;
      }

      setLoading(true);
      await doFetch(regime, false);
    },
    [journalId, doFetch],
  );

  useEffect(() => {
    // Skip the initial empty render before the journal id is resolved —
    // otherwise the first fetch goes out without a journal scope and
    // forces a second one once it arrives.
    if (!journalId) return;
    fetchData(activeRegime);
  }, [fetchData, activeRegime, journalId]);

  // ── Mount-time sync ──────────────────────────────────────────────────────
  // Non-blocking: page renders from cache immediately, then checks for any
  // fills that arrived while the app was closed or the user was on another page.
  useEffect(() => {
    if (!journalId || hasMountSynced.current) return;
    hasMountSynced.current = true;
    authFetch('/api/sync', { method: 'POST' })
      .then((r) => r.json())
      .then((data: { imported?: number }) => {
        if ((data.imported ?? 0) > 0) {
          // Clear the cache so the next fetchData call does a real fetch,
          // then refresh in the background (no spinner).
          const cacheKey = `${journalId}|${activeRegime ?? ''}`;
          dashboardCache.delete(cacheKey);
          doFetch(activeRegime, true).catch(console.error);
        }
      })
      .catch(() => {});
  // authFetch, doFetch, activeRegime are stable for this one-shot effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalId]);

  // ── React to background polling sync finds ───────────────────────────────
  // When the 60-second poller finds new trades it bumps lastSyncImport.
  // Background-refresh the dashboard so the new fills appear.
  useEffect(() => {
    if (lastSyncImport === lastSyncImportRef.current) return;
    lastSyncImportRef.current = lastSyncImport;
    if (!journalId) return;
    const cacheKey = `${journalId}|${activeRegime ?? ''}`;
    dashboardCache.delete(cacheKey);
    doFetch(activeRegime, true).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSyncImport]);

  // ── Live: react to new fills ───────────────────────────────────────────────
  // On isNewPosition=true → fetch the full Position, open TradeAnnotationPopup
  // so the user can tag thesis/strategy while it's fresh. On scale-in fills
  // → toast only, since the position already carries context.
  useEffect(() => {
    if (!lastTrade) return;
    if (lastTrade.receivedAt <= lastTradeSeenRef.current) return;
    lastTradeSeenRef.current = lastTrade.receivedAt;

    const direction = lastTrade.side.toUpperCase();
    const priceStr = `$${lastTrade.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

    if (lastTrade.isNewPosition) {
      pushToast(`New trade: ${lastTrade.symbol} ${direction} at ${priceStr}`, 'success');

      // Booba reacts to a fresh entry with a brief uplift.
      setLiveHealthBoost((prev) => prev + 8);

      // Fetch full position so the popup has strategy/regime metadata.
      authFetch(`/api/positions/${lastTrade.positionId}`)
        .then((r) => r.json())
        .then((data) => {
          if (!data?.position) return;
          const p = data.position;
          setLivePopup({
            id: p.id,
            asset: p.asset,
            direction: p.direction,
            pnl: p.aggregatePnl ?? null,
            averageEntryPrice: p.averageEntryPrice ?? null,
            averageExitPrice: p.averageExitPrice ?? null,
            totalSize: p.totalSize ?? null,
            holdTimeSeconds: p.holdTimeSeconds ?? null,
            regimeAtEntry: p.regimeAtEntry ?? null,
            thesis: p.thesis ?? null,
            conviction: p.conviction ?? null,
            emotion: p.emotion ?? null,
            strategyId: p.strategyId ?? null,
            sourceTag: p.sourceTag ?? null,
            invalidationPrice: p.invalidationPrice ?? null,
            targetPrice: p.targetPrice ?? null,
            mistakes: p.mistakes ?? null,
          });
        })
        .catch((err) => console.warn('[live] failed to load new position detail', err));
    } else {
      pushToast(
        `Added to ${lastTrade.symbol} ${direction} position (${lastTrade.amount.toFixed(4)} @ ${priceStr})`,
        'info',
      );
    }

    // Session fatigue warning
    if (lastTrade.sessionWarning) {
      const { tradeNumber, optimalStop, avgPnlAfterOptimal } = lastTrade.sessionWarning;
      pushToast(
        `Trade #${tradeNumber} this session. Your data shows performance drops after trade #${optimalStop}. Avg P&L after that: $${avgPnlAfterOptimal.toFixed(2)}/trade.`,
        'warn',
      );
      setLiveHealthBoost((prev) => prev - 8);
    }

    // Regime context
    if (lastTrade.regimeContext) {
      const { currentRegime, assetRegimeWinRate, baselineWinRate } = lastTrade.regimeContext;
      const diff = assetRegimeWinRate - baselineWinRate;
      if (Math.abs(diff) > 5) {
        const regime = currentRegime.replace(/_/g, ' ');
        if (diff < 0) {
          pushToast(
            `Regime: ${regime}. ${lastTrade.symbol} win rate here: ${assetRegimeWinRate.toFixed(1)}% vs ${baselineWinRate.toFixed(1)}% baseline. Consider reducing size.`,
            'warn',
          );
          setLiveHealthBoost((prev) => prev - 5);
        } else {
          pushToast(
            `Regime: ${regime}. You perform well here — ${assetRegimeWinRate.toFixed(1)}% win rate vs ${baselineWinRate.toFixed(1)}% baseline.`,
            'info',
          );
        }
      }
    }
  }, [lastTrade, authFetch, pushToast]);

  // ── Live: react to closed positions ────────────────────────────────────────
  // Toast + trigger a background refresh of dashboard data so the equity
  // curve and P&L stats update without the user reloading.
  useEffect(() => {
    if (!lastClosedTrade) return;
    if (lastClosedTrade.receivedAt <= lastClosedSeenRef.current) return;
    lastClosedSeenRef.current = lastClosedTrade.receivedAt;

    const pnl = lastClosedTrade.pnl;
    const pnlStr = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
    pushToast(
      `Closed ${lastClosedTrade.symbol} ${lastClosedTrade.side.toUpperCase()}: ${pnlStr}`,
      pnl >= 0 ? 'success' : 'warn',
    );
    // Booba mood: winning close → boost; losing close → nervous tick.
    setLiveHealthBoost((prev) => (pnl >= 0 ? prev + 15 : prev - 10));

    // Invalidate cache for current journal so a refresh grabs fresh data.
    dashboardCache.forEach((_, key) => {
      if (key.startsWith(`${journalId}|`)) dashboardCache.delete(key);
    });
    if (journalId) fetchData(activeRegime);
  }, [lastClosedTrade, pushToast, journalId, activeRegime, fetchData]);

  // ── Live: decay the transient Booba mood bump ─────────────────────────────
  // The boost/penalty added by new/closed trades fades back to 0 over ~20s
  // so Booba doesn't stay euphoric or nervous forever.
  useEffect(() => {
    if (liveHealthBoost === 0) return;
    const t = setTimeout(() => {
      setLiveHealthBoost((prev) => {
        if (Math.abs(prev) < 1) return 0;
        return prev * 0.7;
      });
    }, 3_000);
    return () => clearTimeout(t);
  }, [liveHealthBoost]);

  const handleRegimeToggle = (regime: string) => {
    const next = activeRegime === regime ? null : regime;
    setActiveRegime(next);
  };


  const hasData = performance && performance.tradeCount > 0;

  // ── Onboarding import handler ───────────────────────────────────────────
  const handleImport = async () => {
    setImporting(true);
    setImportProgress('Fetching trades from Pacifica…');
    setImportDone(false);
    setImportSummary(null);
    try {
      const res = await authFetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regimes: true }),
      });
      const data = await res.json();
      const summary = data.summary;
      const steps = data.steps;

      const totalFills = summary?.totalFills ?? 0;
      const totalPositions = summary?.totalPositions ?? 0;

      // Build a human-readable summary from the steps
      const parts: string[] = [];
      if (totalFills > 0) parts.push(`Fetched ${totalFills} fills from Pacifica`);
      if (steps?.trades?.upserted > 0) parts.push(`Imported ${steps.trades.upserted} trades`);
      if (totalPositions > 0) parts.push(`Grouped into ${totalPositions} positions`);
      if (steps?.regimes?.tagged > 0) parts.push(`Tagged ${steps.regimes.tagged} trades with market regime`);

      setImportSummary(
        parts.length > 0
          ? parts.join('. ') + '.'
          : summary?.message ?? 'Import complete.',
      );
      setImportDone(true);
      setImportProgress(null);
    } catch {
      setImportSummary('Import failed — check server logs.');
      setImportDone(true);
      setImportProgress(null);
    } finally {
      setImporting(false);
    }
  };

  // After a successful import, clear the cache so the dashboard always fetches
  // fresh data (the import just added new trades, so cached data is stale).
  const handleFinishOnboarding = () => {
    setImportDone(false);
    setImportSummary(null);
    dashboardCache.forEach((_, key) => {
      if (key.startsWith(`${journalId}|`)) dashboardCache.delete(key);
    });
    fetchData(null);
  };

  // ── Onboarding screen (first-time user, no data) ──────────────────────
  if (!loading && !hasData && !importDone) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <h1 className="text-3xl font-bold text-white tracking-wider mb-2">Welcome to Booba!</h1>
        <p className="text-sm text-[#8b949e] max-w-md mb-8">
          Let's import your Pacifica trading history. We'll fetch your fills, group them into positions, and tag market regimes automatically.
        </p>

        {importProgress && (
          <div className="mb-6 flex items-center gap-3 text-sm text-[#8b949e]">
            <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            {importProgress}
          </div>
        )}

        {!importing && (
          <button
            onClick={handleImport}
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors"
          >
            Import Trades
          </button>
        )}

        <p className="text-xs text-[#6e7681] mt-6 max-w-xs">
          This may take up to 30 seconds depending on your trade history. Read-only — Booba only reads your public trade data.
        </p>
      </div>
    );
  }

  // ── Import complete screen ────────────────────────────────────────────
  if (importDone && importSummary) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="w-12 h-12 rounded-full bg-emerald-900/30 flex items-center justify-center mb-4">
          <span className="text-emerald-400 text-xl">&#10003;</span>
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">Import Complete</h2>
        <p className="text-sm text-[#8b949e] max-w-md mb-8">{importSummary}</p>
        <button
          onClick={handleFinishOnboarding}
          className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors"
        >
          Go to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-lg font-semibold text-white">Dashboard</h1>
      </div>

      {/* ── Stats Bar ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-10 gap-3">
        <StatCard
          label="Total P&L"
          value={
            <span className={performance ? pnlColor(performance.totalPnl) : 'text-[#6e7681]'}>
              {performance ? formatPnl(performance.totalPnl) : '—'}
            </span>
          }
        />
        <StatCard
          label="Win Rate"
          value={performance ? formatPercent(performance.winRate) : '—'}
        />
        <StatCard
          label="Total Trades"
          value={performance?.tradeCount ?? '—'}
        />
        <StatCard
          label="Expectancy"
          value={
            <span className={performance ? pnlColor(performance.expectancy) : 'text-[#6e7681]'}>
              {performance ? formatPnl(performance.expectancy) : '—'}
            </span>
          }
          sub="avg $ per trade"
        />
        <StatCard
          label="Profit Factor"
          value={performance ? performance.profitFactor.toFixed(2) : '—'}
        />
        <StatCard
          label="Tilt Score"
          value={
            performance && (performance.tiltCoverage ?? 0) > 0 ? (
              <span className={tiltColor(Math.round((performance.avgTiltScore ?? 0) * 100))}>
                {Math.round((performance.avgTiltScore ?? 0) * 100)}
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub={
            performance && (performance.tiltEpisodeCount ?? 0) > 0
              ? `${performance.tiltEpisodeCount} episode${performance.tiltEpisodeCount === 1 ? '' : 's'}`
              : 'avg 0-100, wallet-wide'
          }
        />
        <StatCard
          label="ELO"
          value={
            eloResult ? (
              <span className="flex items-center gap-1.5">
                <span className={eloColor(eloResult.currentElo)}>
                  {Math.round(eloResult.currentElo)}
                </span>
                <span className="text-xs text-[#6e7681]">{trendArrow(eloResult.recentTrend)}</span>
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub={eloResult ? `${eloResult.tier} · peak ${Math.round(eloResult.peakElo)}` : 'chess-style rating'}
        />
        <StatCard
          label="Discipline"
          value={
            entropyResult ? (
              <span className="flex items-center gap-1.5">
                <span className={disciplineColor(entropyResult.compositeScore)}>
                  {Math.round(entropyResult.compositeScore)}
                </span>
                <span className="text-xs text-[#6e7681]">/100</span>
                <span className="text-xs text-[#6e7681]">{trendArrow(entropyResult.trend)}</span>
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub="Shannon entropy"
        />
        <StatCard
          label="Consistency"
          value={
            equityConsistency != null ? (
              <span className={consistencyColor(equityConsistency)}>
                {Math.round(equityConsistency * 100)}%
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub="equity curve R²"
        />
        <StatCard
          label="WART"
          value={
            wartResult ? (
              <span className={wartColor(wartResult.composite)}>
                {formatWart(wartResult.composite)}
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub={wartResult ? wartResult.tier : 'composite trader score'}
        />
      </div>

      {/* ── Open Positions (live) ─────────────────────────────────────────── */}
      <OpenPositions
        openPositions={openPositions}
        initialPositions={initialPositions}
        connected={connected}
      />

      {/* ── Equity Curve ──────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Equity Curve</h2>
            {(activeRegime || equityConsistency != null || xpnlSummary || drawdownStats) && (
              <p className="text-xs text-[#6e7681] mt-0.5 flex items-center gap-3 flex-wrap">
                {activeRegime && (
                  <span>
                    Showing trades in{' '}
                    <span className="text-amber-400">
                      {REGIME_LABELS[activeRegime] ?? activeRegime}
                    </span>{' '}
                    only
                  </span>
                )}
                {equityConsistency != null && (
                  <span>
                    Consistency:{' '}
                    <span className={consistencyColor(equityConsistency)}>
                      {Math.round(equityConsistency * 100)}%
                    </span>
                  </span>
                )}
                {xpnlSummary && (
                  <span>
                    Luck score:{' '}
                    <span className={xpnlSummary.luckScore >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {xpnlSummary.luckScore >= 0 ? '+' : ''}
                      {Math.round(xpnlSummary.luckScore * 100)}%
                    </span>
                  </span>
                )}
                {drawdownStats && (
                  <span>
                    Max DD:{' '}
                    <span className="text-red-400">
                      -${Math.abs(drawdownStats.maxDrawdown).toFixed(2)} (
                      {drawdownStats.maxDrawdownPct.toFixed(1)}%)
                    </span>
                    {' · Current: '}
                    <span className={drawdownStats.currentDrawdown < 0 ? 'text-red-400' : 'text-[#8b949e]'}>
                      {drawdownStats.currentDrawdown < 0
                        ? `-$${Math.abs(drawdownStats.currentDrawdown).toFixed(2)} (${drawdownStats.currentDrawdownPct.toFixed(1)}%)`
                        : '$0.00'}
                    </span>
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Regime filter toggles */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setShowXpnlOverlay((v) => !v)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                showXpnlOverlay
                  ? 'bg-slate-700/60 text-slate-200 ring-1 ring-current'
                  : 'bg-[#21262d] text-[#6e7681] hover:text-[#8b949e]'
              }`}
              title="Toggle expected P&L overlay"
            >
              Expected P&L
            </button>
            {FILTER_REGIMES.map(({ key, label }) => {
              const isActive = activeRegime === key;
              const badge = REGIME_BADGE[key];
              return (
                <button
                  key={key}
                  onClick={() => handleRegimeToggle(key)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                    isActive
                      ? `${badge.bg} ${badge.text} ring-1 ring-current`
                      : 'bg-[#21262d] text-[#6e7681] hover:text-[#8b949e]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            {activeRegime && (
              <button
                onClick={() => setActiveRegime(null)}
                className="px-2.5 py-1 rounded text-xs text-[#6e7681] hover:text-white bg-[#21262d] transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-[#6e7681] text-sm">
            Loading…
          </div>
        ) : (
          <>
            <EquityCurve
              equityCurve={equityCurve}
              tradeMetas={tradeMetas}
              activeRegimeFilter={activeRegime}
              xpnlSeries={xpnlSummary?.cumulativeSeries}
              showXpnl={showXpnlOverlay}
            />
            {underwaterSeries.length > 0 && (
              <div className="mt-2 pt-2 border-t border-[#21262d]">
                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Underwater
                </div>
                <UnderwaterCurve series={underwaterSeries} />
              </div>
            )}
          </>
        )}

        {/* Regime legend */}
        {!activeRegime && hasData && (
          <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-[#21262d]">
            {Object.entries(REGIME_BADGE).map(([key, { label, bg }]) => (
              <span key={key} className="flex items-center gap-1.5 text-xs text-[#6e7681]">
                <span className={`w-3 h-3 rounded-sm ${bg}`} />
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Booba Avatar + Chat ──────────────────────────────────────────── */}
      <BoobaChat isOpen={chatOpen} onClose={() => setChatOpen(false)} />
      <BoobaAvatar
        healthScore={Math.max(0, Math.min(100, computeHealthScore({
          wartComposite: wartResult?.composite,
          tiltScore: performance ? Math.round((performance.avgTiltScore ?? 0) * 100) : undefined,
          eloTrend: eloResult?.recentTrend,
          recentWinRate: performance?.winRate,
          currentDrawdownPct:
            // Blend historical drawdown with live unrealized drawdown so
            // a negative unrealized P&L below -5% of notional drags Booba
            // into nervous territory even before the trade closes.
            (() => {
              const live = liveUnrealizedDrawdownPct(openPositions);
              const historic = drawdownStats && drawdownStats.currentDrawdown < 0
                ? -Math.abs(drawdownStats.currentDrawdownPct)
                : undefined;
              if (live != null && historic != null) return Math.min(live, historic);
              return live ?? historic;
            })(),
        })) + Math.round(liveHealthBoost))}
        insight={chatOpen ? null : getContextualMessage('dashboard', {
          untaggedPositionCount,
          lastComputedAt,
          totalTrades: performance?.tradeCount ?? 0,
          wartResult: wartResult ?? undefined,
          tiltEpisodeCount: performance?.tiltEpisodeCount ?? undefined,
          eloResult: eloResult ?? undefined,
          entropyResult: entropyResult ?? undefined,
          xpnlLuckScore: xpnlSummary?.luckScore ?? undefined,
          insights: insights.map((i) => ({
            module: i.module,
            title: i.title,
            description: i.description,
            isSignificant: i.isSignificant,
            impactScore: i.impactScore,
            data: i.data,
          })),
        })}
        eloTrend={eloResult?.recentTrend}
        wartTrend={wartResult?.composite}
        onChatToggle={() => setChatOpen((o) => !o)}
        chatOpen={chatOpen}
      />

      {/* ── Live notifications ───────────────────────────────────────────── */}
      <LiveToast toasts={toasts} />
      {livePopup && (
        <TradeAnnotationPopup
          position={livePopup}
          onClose={() => setLivePopup(null)}
          onSaved={(msg) => {
            pushToast(msg, 'success');
            setLivePopup(null);
            // Refresh the dashboard so the newly-tagged position's
            // metadata shows up across the UI.
            dashboardCache.forEach((_, key) => {
              if (key.startsWith(`${journalId}|`)) dashboardCache.delete(key);
            });
            if (journalId) fetchData(activeRegime);
          }}
        />
      )}
    </div>
  );
}
