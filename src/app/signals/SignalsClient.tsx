'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import SignalInput from './SignalInput';
import CallerAnalyticsModal from './CallerAnalyticsModal';
import BoobaChat from '@/app/components/booba/BoobaChat';

// ── Types ────────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  callerName: string;
  asset: string;
  direction: string;
  entryPrice: number;
  targetPrice: number | null;
  targetPrices: string | null;
  targetPricesHit: string | null;
  stopPrice: number | null;
  status: string;
  outcomePrice: number | null;
  outcomePnlPct: number | null;
  outcomeRMultiple: number | null;
  source: string;
  channelName: string | null;
  positionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface CallerStats {
  callerName: string;
  totalSignals: number;
  hitTargets: number;
  hitStops: number;
  expired: number;
  open: number;
  hitRate: number;
  avgPnlPct: number | null;
  avgRMultiple: number | null;
  bestSignal: { asset: string; direction: string; pnlPct: number } | null;
  worstSignal: { asset: string; direction: string; pnlPct: number } | null;
}

interface SourceInfo {
  type: string;
  label: string;
  icon: string;
  status: 'active' | 'experimental' | 'not_configured';
  todayCount: number;
  experimental: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, digits = 1, prefix = ''): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${prefix}${sign}${n.toFixed(digits)}`;
}

function hitRateColor(rate: number): string {
  if (rate > 0.55) return '#3fb950';
  if (rate >= 0.45) return '#d29922';
  return '#f85149';
}

function rMultipleColor(r: number | null): string {
  if (r == null) return '#8b949e';
  if (r > 1.5) return '#3fb950';
  if (r >= 1.0) return '#d29922';
  return '#f85149';
}

function pnlColor(pnl: number | null): string {
  if (pnl == null) return '#8b949e';
  return pnl >= 0 ? '#3fb950' : '#f85149';
}

function statusBadge(status: string): React.CSSProperties {
  const colors: Record<string, { bg: string; color: string }> = {
    open:           { bg: 'rgba(31,111,235,0.15)',  color: '#58a6ff' },
    hit_target:     { bg: 'rgba(35,134,54,0.2)',    color: '#3fb950' },
    hit_stop:       { bg: 'rgba(218,54,51,0.2)',    color: '#f85149' },
    partial_target: { bg: 'rgba(210,153,34,0.2)',   color: '#d29922' },
    expired:        { bg: 'rgba(110,118,129,0.2)',  color: '#8b949e' },
    closed_manual:  { bg: 'rgba(110,118,129,0.2)',  color: '#8b949e' },
  };
  const c = colors[status] ?? colors.open;
  return {
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    background: c.bg,
    color: c.color,
  };
}

const RANK_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32'];

function callerInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function avatarBg(name: string): string {
  const colors = ['#1f6feb', '#238636', '#9e6a03', '#8250df', '#bf4b8a', '#0d6efd'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffff;
  return colors[Math.abs(hash) % colors.length];
}

// ── Simulation metadata helpers (Fix 5) ─────────────────────────────────────

function selectTimeframeClient(
  entryPrice: number,
  stopPrice: number | null,
  targetPrice: number | null,
): string {
  const reference = stopPrice ?? targetPrice;
  if (reference == null) return '1h';
  const distancePct = (Math.abs(entryPrice - reference) / entryPrice) * 100;
  if (distancePct < 1)  return '1m';
  if (distancePct < 3)  return '5m';
  if (distancePct < 10) return '15m';
  return '1h';
}

function timeframeMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  };
  return map[tf] ?? 3_600_000;
}

function formatDuration(ms: number): string {
  const days  = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins  = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function SimulationMeta({ sig }: { sig: Signal }) {
  if (!sig.resolvedAt || sig.status === 'open') return null;
  const tf = selectTimeframeClient(sig.entryPrice, sig.stopPrice, sig.targetPrice);
  const durationMs = new Date(sig.resolvedAt).getTime() - new Date(sig.createdAt).getTime();
  if (durationMs <= 0) return null;
  const candleCount = Math.ceil(durationMs / timeframeMs(tf));
  const duration = formatDuration(durationMs);
  return (
    <tr>
      <td colSpan={9} style={{ padding: '3px 12px 8px', borderBottom: '1px solid #161b22' }}>
        <span style={{ fontSize: '11px', color: '#484f58' }}>
          📊 Simulated: ~{candleCount.toLocaleString()} candles ({tf}) over {duration}
        </span>
      </td>
    </tr>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function SignalsClient() {
  const [callers, setCallers]     = useState<CallerStats[]>([]);
  const [signals, setSignals]     = useState<Signal[]>([]);
  const [sources, setSources]     = useState<SourceInfo[]>([]);
  const [expandedCaller, setExpandedCaller]   = useState<string | null>(null);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [analyticsCaller, setAnalyticsCaller] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const [checking, setChecking]   = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [chatOpen, setChatOpen]   = useState(false);
  const authFetch = useAuthFetch();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [lbRes, sigRes, srcRes] = await Promise.all([
        authFetch('/api/signals/leaderboard'),
        authFetch('/api/signals?limit=200'),
        authFetch('/api/signals/sources'),
      ]);
      const lb  = await lbRes.json();
      const sig = await sigRes.json();
      const src = await srcRes.json();
      setCallers(lb.callers ?? []);
      setSignals(sig.signals ?? []);
      setSources(src.sources ?? []);
    } catch (err) {
      console.error('[SignalsClient] load error', err);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleCheckOutcomes() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await authFetch('/api/signals/check', { method: 'POST' });
      const data = await res.json();
      setCheckResult(
        data.updated === 0
          ? 'All signals up to date'
          : `Updated ${data.updated} signal${data.updated === 1 ? '' : 's'}`,
      );
      await loadData();
    } catch {
      setCheckResult('Check failed');
    } finally {
      setChecking(false);
    }
  }

  // Fix 7: split by resolved count
  const qualifiedCallers = callers.filter((c) => (c.totalSignals - c.open) >= 3);
  const pendingCallers   = callers.filter((c) => (c.totalSignals - c.open) < 3);

  // Fix 4: headline stats
  const totalSignals = callers.reduce((sum, c) => sum + c.totalSignals, 0);
  const bestCaller   = [...callers]
    .filter((c) => (c.totalSignals - c.open) >= 5)
    .sort((a, b) => b.hitRate - a.hitRate)[0] ?? null;

  function handleAskBooba() {
    setChatOpen(true);
  }

  return (
    <div style={{ color: '#c9d1d9', fontFamily: 'monospace' }}>
      {/* Page header — no h1 (Fix 1); keep subtitle + Check Outcomes */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <p style={{ margin: 0, color: '#8b949e', fontSize: '13px' }}>
          Track external calls, measure outcomes, find real edge.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {checkResult && (
            <span style={{ color: '#8b949e', fontSize: '12px' }}>{checkResult}</span>
          )}
          <button
            onClick={handleCheckOutcomes}
            disabled={checking}
            style={{
              padding: '7px 16px',
              borderRadius: '6px',
              border: '1px solid #30363d',
              background: '#21262d',
              color: checking ? '#6e7681' : '#c9d1d9',
              fontSize: '13px',
              fontWeight: 600,
              cursor: checking ? 'not-allowed' : 'pointer',
            }}
          >
            {checking ? 'Checking…' : 'Check Outcomes'}
          </button>
        </div>
      </div>

      {/* Signal Input — compact row (Fix 2) */}
      <section style={{ marginBottom: '16px' }}>
        <SignalInput onSignalAdded={loadData} onAskBooba={handleAskBooba} />
      </section>

      {/* Headline stat (Fix 4) */}
      {!loading && (
        <div style={{ marginBottom: '20px', padding: '10px 14px', background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', fontSize: '13px', color: '#8b949e' }}>
          {totalSignals === 0 ? (
            <span>No signals tracked yet. Paste a call or connect a source to get started.</span>
          ) : (
            <span>
              <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{totalSignals}</span>
              {' signals from '}
              <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{callers.length}</span>
              {' caller'}
              {callers.length !== 1 ? 's' : ''}
              {bestCaller && (
                <>
                  {'. Best: '}
                  <span style={{ color: '#e6edf3', fontWeight: 600 }}>{bestCaller.callerName}</span>
                  {' ('}
                  <span style={{ color: hitRateColor(bestCaller.hitRate), fontWeight: 600 }}>
                    {(bestCaller.hitRate * 100).toFixed(0)}% hit rate
                  </span>
                  {bestCaller.avgRMultiple != null && (
                    <>, <span style={{ color: rMultipleColor(bestCaller.avgRMultiple), fontWeight: 600 }}>{fmt(bestCaller.avgRMultiple)}R avg</span></>
                  )}
                  {')'}
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* Signal Sources (Fix 3) */}
      {sources.length > 0 && (
        <section style={{ marginBottom: '28px' }}>
          <SectionHeader>Signal Sources</SectionHeader>
          <SignalSources sources={sources} />
        </section>
      )}

      {/* Caller Leaderboard (Fix 7: qualified callers only in main table) */}
      <section style={{ marginBottom: '32px' }}>
        <SectionHeader>Caller Leaderboard</SectionHeader>

        {loading ? (
          <div style={{ color: '#484f58', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>
            Loading…
          </div>
        ) : qualifiedCallers.length === 0 && pendingCallers.length === 0 ? (
          <EmptyState text="No signals yet. Paste a call above to get started." />
        ) : (
          <>
            {qualifiedCallers.length > 0 && (
              <LeaderboardTable
                callers={qualifiedCallers}
                signals={signals}
                expandedCaller={expandedCaller}
                setExpandedCaller={setExpandedCaller}
                setAnalyticsCaller={setAnalyticsCaller}
              />
            )}

            {/* Pending callers — collapsed by default (Fix 7) */}
            {pendingCallers.length > 0 && (
              <div style={{ marginTop: qualifiedCallers.length > 0 ? '12px' : '0' }}>
                <button
                  onClick={() => setPendingExpanded(!pendingExpanded)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: 'none',
                    border: '1px solid #30363d',
                    borderRadius: '6px',
                    color: '#8b949e',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '6px 12px',
                    fontFamily: 'monospace',
                  }}
                >
                  <span style={{ fontSize: '10px' }}>{pendingExpanded ? '▼' : '▶'}</span>
                  Callers with open signals ({pendingCallers.length})
                </button>

                {pendingExpanded && (
                  <div style={{ marginTop: '8px' }}>
                    <LeaderboardTable
                      callers={pendingCallers}
                      signals={signals}
                      expandedCaller={expandedCaller}
                      setExpandedCaller={setExpandedCaller}
                      setAnalyticsCaller={setAnalyticsCaller}
                      dimmed
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Your Execution vs Callers (Fix 6: always shown for all callers) */}
      {!loading && callers.length > 0 && (
        <section style={{ marginBottom: '32px' }}>
          <SectionHeader>Your Execution vs Callers</SectionHeader>
          <ExecutionPanel signals={signals} callers={callers} />
        </section>
      )}

      {/* Caller analytics modal */}
      {analyticsCaller && (
        <CallerAnalyticsModal
          callerName={analyticsCaller}
          onClose={() => setAnalyticsCaller(null)}
        />
      )}

      {/* Booba chat */}
      <BoobaChat
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        prefillMessage="Track a new signal for me."
      />
    </div>
  );
}

// ── Leaderboard table ────────────────────────────────────────────────────────

interface LeaderboardTableProps {
  callers: CallerStats[];
  signals: Signal[];
  expandedCaller: string | null;
  setExpandedCaller: (name: string | null) => void;
  setAnalyticsCaller: (name: string | null) => void;
  dimmed?: boolean;
}

function LeaderboardTable({
  callers, signals, expandedCaller, setExpandedCaller, setAnalyticsCaller, dimmed = false,
}: LeaderboardTableProps) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden', opacity: dimmed ? 0.75 : 1 }}>
      {/* Table header */}
      <div style={{ ...tableRow, background: '#0d1117', borderBottom: '1px solid #30363d', color: '#6e7681', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <span style={{ width: '40px' }}>Rank</span>
        <span style={{ flex: 2 }}>Caller</span>
        <span style={{ width: '70px', textAlign: 'right' }}>Signals</span>
        <span style={{ width: '80px', textAlign: 'right' }}>Hit Rate</span>
        <span style={{ width: '70px', textAlign: 'right' }}>Avg R</span>
        <span style={{ width: '80px', textAlign: 'right' }}>Avg P&L</span>
        <span style={{ flex: 1, textAlign: 'right' }}>Best Call</span>
        <span style={{ flex: 1, textAlign: 'right', paddingRight: '16px' }}>Worst Call</span>
      </div>

      {callers.map((caller, idx) => {
        const isExpanded = expandedCaller === caller.callerName;
        const rankColor = idx < 3 ? RANK_COLORS[idx] : '#6e7681';
        const callerSignals = signals.filter((s) => s.callerName === caller.callerName);
        const resolved = caller.totalSignals - caller.open;

        return (
          <div key={caller.callerName}>
            {/* Caller row */}
            <div
              onClick={() => setExpandedCaller(isExpanded ? null : caller.callerName)}
              style={{
                ...tableRow,
                borderBottom: '1px solid #21262d',
                cursor: 'pointer',
                transition: 'background 150ms',
                background: isExpanded ? 'rgba(31,111,235,0.06)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ width: '40px', color: rankColor, fontWeight: 700, fontSize: '14px' }}>
                {idx < 3 ? ['①', '②', '③'][idx] : `${idx + 1}`}
              </span>

              <span style={{ flex: 2, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '28px', height: '28px', borderRadius: '50%',
                  background: avatarBg(caller.callerName),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0,
                }}>
                  {callerInitial(caller.callerName)}
                </span>
                <span
                  style={{ color: '#e6edf3', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: '#30363d', textUnderlineOffset: '3px' }}
                  onClick={(e) => { e.stopPropagation(); setAnalyticsCaller(caller.callerName); }}
                >
                  {caller.callerName}
                </span>
                <span style={{ color: '#484f58', fontSize: '11px' }}>
                  {caller.open > 0 ? `${caller.open} open` : ''}
                </span>
              </span>

              <span style={{ width: '70px', textAlign: 'right', color: '#8b949e' }}>
                {caller.totalSignals}
              </span>

              <span style={{ width: '80px', textAlign: 'right', color: hitRateColor(caller.hitRate), fontWeight: 600 }}>
                {resolved > 0 ? `${(caller.hitRate * 100).toFixed(0)}%` : '—'}
              </span>

              <span style={{ width: '70px', textAlign: 'right', color: rMultipleColor(caller.avgRMultiple), fontWeight: 600 }}>
                {caller.avgRMultiple != null ? `${fmt(caller.avgRMultiple)}R` : '—'}
              </span>

              <span style={{ width: '80px', textAlign: 'right', color: pnlColor(caller.avgPnlPct), fontWeight: 600 }}>
                {caller.avgPnlPct != null ? `${fmt(caller.avgPnlPct)}%` : '—'}
              </span>

              <span style={{ flex: 1, textAlign: 'right', color: '#3fb950', fontSize: '12px' }}>
                {caller.bestSignal ? `${caller.bestSignal.asset} ${fmt(caller.bestSignal.pnlPct)}%` : '—'}
              </span>

              <span style={{ flex: 1, textAlign: 'right', color: '#f85149', fontSize: '12px', paddingRight: '16px' }}>
                {caller.worstSignal ? `${caller.worstSignal.asset} ${fmt(caller.worstSignal.pnlPct)}%` : '—'}
              </span>
            </div>

            {/* Expanded signal list with simulation metadata (Fix 5) */}
            {isExpanded && (
              <div style={{ background: '#0d1117', borderBottom: '1px solid #30363d' }}>
                {callerSignals.length === 0 ? (
                  <div style={{ padding: '12px 16px', color: '#484f58', fontSize: '12px' }}>No signals</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ color: '#6e7681', borderBottom: '1px solid #21262d' }}>
                        {['Date', 'Asset', 'Dir', 'Entry', 'Targets', 'Stop', 'Status', 'P&L', 'R'].map((h) => (
                          <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {callerSignals.map((sig) => {
                        const tpList: number[] = sig.targetPrices
                          ? JSON.parse(sig.targetPrices)
                          : sig.targetPrice != null ? [sig.targetPrice] : [];
                        const hitList: boolean[] = sig.targetPricesHit
                          ? JSON.parse(sig.targetPricesHit)
                          : [];
                        const isResolved = sig.status !== 'open';

                        return (
                          <React.Fragment key={sig.id}>
                            <tr style={{ borderBottom: sig.resolvedAt ? 'none' : '1px solid #161b22' }}>
                              <td style={{ padding: '7px 12px', color: '#6e7681' }}>
                                {new Date(sig.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </td>
                              <td style={{ padding: '7px 12px', color: '#e6edf3', fontWeight: 600 }}>{sig.asset}</td>
                              <td style={{ padding: '7px 12px' }}>
                                <span style={{ color: sig.direction === 'LONG' ? '#3fb950' : '#f85149', fontWeight: 700 }}>
                                  {sig.direction}
                                </span>
                              </td>
                              <td style={{ padding: '7px 12px', color: '#c9d1d9' }}>${sig.entryPrice.toLocaleString()}</td>
                              <td style={{ padding: '7px 12px' }}>
                                {tpList.length === 0 ? (
                                  <span style={{ color: '#484f58' }}>—</span>
                                ) : tpList.length === 1 ? (
                                  <span style={{ color: isResolved && hitList[0] === false ? '#f85149' : '#3fb950' }}>
                                    ${tpList[0].toLocaleString()}
                                    {isResolved && hitList.length > 0 && (
                                      <span style={{ marginLeft: '3px' }}>{hitList[0] ? '✓' : '✗'}</span>
                                    )}
                                  </span>
                                ) : (
                                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                    {tpList.map((tp, i) => {
                                      const hit = hitList[i];
                                      const color = !isResolved || hitList.length === 0
                                        ? '#3fb950'
                                        : hit ? '#3fb950' : '#6e7681';
                                      return (
                                        <span key={i} style={{ color, whiteSpace: 'nowrap' }}>
                                          TP{i + 1}:&nbsp;${tp.toLocaleString()}
                                          {isResolved && hitList.length > 0 && (
                                            <span style={{ color: hit ? '#3fb950' : '#f85149' }}>{hit ? ' ✓' : ' ✗'}</span>
                                          )}
                                        </span>
                                      );
                                    })}
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: '7px 12px', color: '#f85149' }}>
                                {sig.stopPrice ? `$${sig.stopPrice.toLocaleString()}` : '—'}
                              </td>
                              <td style={{ padding: '7px 12px' }}>
                                <span style={statusBadge(sig.status)}>
                                  {sig.status.replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td style={{ padding: '7px 12px', color: pnlColor(sig.outcomePnlPct), fontWeight: 600 }}>
                                {sig.outcomePnlPct != null ? `${fmt(sig.outcomePnlPct)}%` : '—'}
                              </td>
                              <td style={{ padding: '7px 12px', color: rMultipleColor(sig.outcomeRMultiple) }}>
                                {sig.outcomeRMultiple != null ? `${fmt(sig.outcomeRMultiple)}R` : '—'}
                              </td>
                            </tr>
                            {/* Simulation metadata row (Fix 5) */}
                            <SimulationMeta sig={sig} />
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Signal Sources (Fix 3) ───────────────────────────────────────────────────

function SignalSources({ sources }: { sources: SourceInfo[] }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
      {sources.map((src, i) => (
        <div
          key={src.type}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '10px 16px',
            borderBottom: i < sources.length - 1 ? '1px solid #21262d' : 'none',
            gap: '10px',
          }}
        >
          <span style={{ fontSize: '16px', width: '22px', flexShrink: 0 }}>{src.icon}</span>
          <span style={{ flex: 1, color: '#c9d1d9', fontSize: '13px', fontWeight: 500 }}>{src.label}</span>

          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {src.status === 'active' && (
              <span style={{ color: '#3fb950', fontSize: '12px', fontWeight: 600 }}>Active</span>
            )}
            {src.status === 'experimental' && (
              <span style={{
                padding: '1px 7px', borderRadius: '4px',
                background: 'rgba(210,153,34,0.15)', color: '#d29922',
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em',
              }}>
                Experimental
              </span>
            )}
            {src.status === 'not_configured' && (
              <span style={{ color: '#484f58', fontSize: '12px' }}>Not configured</span>
            )}

            {src.todayCount > 0 && (
              <span style={{ color: '#6e7681', fontSize: '12px' }}>
                · {src.todayCount} signal{src.todayCount !== 1 ? 's' : ''} today
              </span>
            )}
            {src.status === 'experimental' && src.todayCount === 0 && (
              <span style={{ color: '#6e7681', fontSize: '12px' }}>
                · monitoring
              </span>
            )}
          </span>
        </div>
      ))}

      <div style={{ padding: '10px 16px', borderTop: '1px solid #21262d', display: 'flex', justifyContent: 'flex-end' }}>
        <a
          href="/settings"
          style={{
            color: '#58a6ff',
            fontSize: '12px',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          + Connect Source
        </a>
      </div>
    </div>
  );
}

// ── Execution panel (Fix 6) ──────────────────────────────────────────────────

interface ExecutionPanelProps {
  signals: Signal[];
  callers: CallerStats[];
}

function ExecutionPanel({ signals, callers }: ExecutionPanelProps) {
  // Group linked signals (positionId set) by callerName
  const linkedByCallerMap = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!s.positionId) continue;
    const arr = linkedByCallerMap.get(s.callerName) ?? [];
    arr.push(s);
    linkedByCallerMap.set(s.callerName, arr);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {callers.map((callerStats) => {
        const linkedSigs  = linkedByCallerMap.get(callerStats.callerName) ?? [];
        const hasLinked   = linkedSigs.length > 0;
        const callerAvg   = callerStats.avgPnlPct;
        const callerR     = callerStats.avgRMultiple;

        const userSigsWithPnl = linkedSigs.filter((s) => s.outcomePnlPct != null);
        const userAvg = userSigsWithPnl.length > 0
          ? userSigsWithPnl.reduce((sum, s) => sum + s.outcomePnlPct!, 0) / userSigsWithPnl.length
          : null;
        const gap = callerAvg != null && userAvg != null ? userAvg - callerAvg : null;

        return (
          <div key={callerStats.callerName} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <span style={{
                width: '24px', height: '24px', borderRadius: '50%',
                background: avatarBg(callerStats.callerName),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#fff',
              }}>
                {callerInitial(callerStats.callerName)}
              </span>
              <span style={{ color: '#e6edf3', fontWeight: 700 }}>{callerStats.callerName}</span>
            </div>

            {hasLinked ? (
              <>
                <p style={{ margin: '0 0 4px', color: '#8b949e', fontSize: '13px' }}>
                  You followed{' '}
                  <strong style={{ color: '#c9d1d9' }}>{linkedSigs.length}</strong> of{' '}
                  {callerStats.callerName}&apos;s{' '}
                  <strong style={{ color: '#c9d1d9' }}>{callerStats.totalSignals}</strong> signals.
                </p>
                {callerAvg != null && (
                  <p style={{ margin: '0 0 4px', color: '#8b949e', fontSize: '13px' }}>
                    Their signals averaged{' '}
                    <strong style={{ color: pnlColor(callerAvg) }}>{fmt(callerAvg)}%</strong>
                    {callerR != null && (
                      <> · <strong style={{ color: rMultipleColor(callerR) }}>{fmt(callerR)}R</strong></>
                    )}
                    {'.'}
                    {userAvg != null && (
                      <> Your execution of their calls averaged{' '}
                        <strong style={{ color: pnlColor(userAvg) }}>{fmt(userAvg)}%</strong>.
                      </>
                    )}
                  </p>
                )}
                {gap != null && (
                  <p style={{ margin: 0, color: '#8b949e', fontSize: '13px' }}>
                    Gap: <strong style={{ color: pnlColor(gap) }}>{fmt(gap)}%</strong>
                    {gap < 0 && ' — you may be entering late or exiting early on this caller\'s calls.'}
                    {gap > 0 && ' — you\'re outperforming the signal\'s theoretical entry.'}
                  </p>
                )}
              </>
            ) : (
              <>
                {callerAvg != null && (
                  <p style={{ margin: '0 0 6px', color: '#8b949e', fontSize: '13px' }}>
                    Signals averaged{' '}
                    <strong style={{ color: pnlColor(callerAvg) }}>{fmt(callerAvg)}%</strong>
                    {callerR != null && (
                      <> · <strong style={{ color: rMultipleColor(callerR) }}>{fmt(callerR)}R avg</strong></>
                    )}
                    {' across '}
                    <strong style={{ color: '#c9d1d9' }}>{callerStats.totalSignals - callerStats.open}</strong>
                    {' resolved signals.'}
                  </p>
                )}
                <p style={{ margin: 0, color: '#484f58', fontSize: '12px', fontStyle: 'italic' }}>
                  Tag a trade with <strong style={{ color: '#6e7681' }}>{callerStats.callerName}</strong> as the source to see your execution comparison.
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ margin: '0 0 12px', fontSize: '13px', fontWeight: 700, color: '#6e7681', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
      {children}
    </h2>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '40px', textAlign: 'center', color: '#484f58', fontSize: '13px' }}>
      {text}
    </div>
  );
}

const tableRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 16px',
  gap: '8px',
};
