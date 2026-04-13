'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import SignalInput from './SignalInput';

// ── Types ────────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  callerName: string;
  asset: string;
  direction: string;
  entryPrice: number;
  targetPrice: number | null;
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
    open:          { bg: 'rgba(31,111,235,0.15)',  color: '#58a6ff' },
    hit_target:    { bg: 'rgba(35,134,54,0.2)',    color: '#3fb950' },
    hit_stop:      { bg: 'rgba(218,54,51,0.2)',    color: '#f85149' },
    expired:       { bg: 'rgba(110,118,129,0.2)',  color: '#8b949e' },
    closed_manual: { bg: 'rgba(210,153,34,0.2)',   color: '#d29922' },
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

// ── Main Component ───────────────────────────────────────────────────────────

export default function SignalsClient() {
  const [callers, setCallers] = useState<CallerStats[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [expandedCaller, setExpandedCaller] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const authFetch = useAuthFetch();

  const loadLeaderboard = useCallback(async () => {
    setLoading(true);
    try {
      const [lbRes, sigRes] = await Promise.all([
        authFetch('/api/signals/leaderboard'),
        authFetch('/api/signals?limit=200'),
      ]);
      const lb = await lbRes.json();
      const sig = await sigRes.json();
      setCallers(lb.callers ?? []);
      setSignals(sig.signals ?? []);
    } catch (err) {
      console.error('[SignalsClient] load error', err);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { loadLeaderboard(); }, [loadLeaderboard]);

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
      await loadLeaderboard();
    } catch {
      setCheckResult('Check failed');
    } finally {
      setChecking(false);
    }
  }

  // Linked signals for "Your Execution" panel
  const linkedSignals = signals.filter((s) => s.positionId);

  return (
    <div style={{ color: '#c9d1d9', fontFamily: 'monospace' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#e6edf3' }}>Caller Signals</h1>
          <p style={{ margin: '4px 0 0', color: '#8b949e', fontSize: '13px' }}>
            Track external calls, measure outcomes, find real edge.
          </p>
        </div>
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

      {/* Signal Input */}
      <section style={{ marginBottom: '32px' }}>
        <SectionHeader>Add Signal</SectionHeader>
        <SignalInput onSignalAdded={loadLeaderboard} />
      </section>

      {/* Leaderboard */}
      <section style={{ marginBottom: '32px' }}>
        <SectionHeader>Caller Leaderboard</SectionHeader>

        {loading ? (
          <div style={{ color: '#484f58', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>
            Loading…
          </div>
        ) : callers.length === 0 ? (
          <EmptyState text="No signals yet. Paste a call above to get started." />
        ) : (
          <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
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
                    {/* Rank */}
                    <span style={{ width: '40px', color: rankColor, fontWeight: 700, fontSize: '14px' }}>
                      {idx < 3 ? ['①', '②', '③'][idx] : `${idx + 1}`}
                    </span>

                    {/* Avatar + name */}
                    <span style={{ flex: 2, display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{
                        width: '28px', height: '28px', borderRadius: '50%',
                        background: avatarBg(caller.callerName),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0,
                      }}>
                        {callerInitial(caller.callerName)}
                      </span>
                      <span style={{ color: '#e6edf3', fontWeight: 600 }}>{caller.callerName}</span>
                      <span style={{ color: '#484f58', fontSize: '11px' }}>
                        {caller.open > 0 ? `${caller.open} open` : ''}
                      </span>
                    </span>

                    <span style={{ width: '70px', textAlign: 'right', color: '#8b949e' }}>
                      {caller.totalSignals}
                    </span>

                    <span style={{ width: '80px', textAlign: 'right', color: hitRateColor(caller.hitRate), fontWeight: 600 }}>
                      {caller.hitTargets + caller.hitStops + caller.expired > 0
                        ? `${(caller.hitRate * 100).toFixed(0)}%`
                        : '—'}
                    </span>

                    <span style={{ width: '70px', textAlign: 'right', color: rMultipleColor(caller.avgRMultiple), fontWeight: 600 }}>
                      {caller.avgRMultiple != null ? `${fmt(caller.avgRMultiple)}R` : '—'}
                    </span>

                    <span style={{ width: '80px', textAlign: 'right', color: pnlColor(caller.avgPnlPct), fontWeight: 600 }}>
                      {caller.avgPnlPct != null ? `${fmt(caller.avgPnlPct)}%` : '—'}
                    </span>

                    <span style={{ flex: 1, textAlign: 'right', color: '#3fb950', fontSize: '12px' }}>
                      {caller.bestSignal
                        ? `${caller.bestSignal.asset} ${fmt(caller.bestSignal.pnlPct)}%`
                        : '—'}
                    </span>

                    <span style={{ flex: 1, textAlign: 'right', color: '#f85149', fontSize: '12px', paddingRight: '16px' }}>
                      {caller.worstSignal
                        ? `${caller.worstSignal.asset} ${fmt(caller.worstSignal.pnlPct)}%`
                        : '—'}
                    </span>
                  </div>

                  {/* Expanded signal list */}
                  {isExpanded && (
                    <div style={{ background: '#0d1117', borderBottom: '1px solid #30363d' }}>
                      {callerSignals.length === 0 ? (
                        <div style={{ padding: '12px 16px', color: '#484f58', fontSize: '12px' }}>No signals</div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                          <thead>
                            <tr style={{ color: '#6e7681', borderBottom: '1px solid #21262d' }}>
                              {['Date', 'Asset', 'Dir', 'Entry', 'Target', 'Stop', 'Status', 'P&L', 'R'].map((h) => (
                                <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {callerSignals.map((sig) => (
                              <tr key={sig.id} style={{ borderBottom: '1px solid #161b22' }}>
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
                                <td style={{ padding: '7px 12px', color: '#3fb950' }}>
                                  {sig.targetPrice ? `$${sig.targetPrice.toLocaleString()}` : '—'}
                                </td>
                                <td style={{ padding: '7px 12px', color: '#f85149' }}>
                                  {sig.stopPrice ? `$${sig.stopPrice.toLocaleString()}` : '—'}
                                </td>
                                <td style={{ padding: '7px 12px' }}>
                                  <span style={statusBadge(sig.status)}>
                                    {sig.status.replace('_', ' ')}
                                  </span>
                                </td>
                                <td style={{ padding: '7px 12px', color: pnlColor(sig.outcomePnlPct), fontWeight: 600 }}>
                                  {sig.outcomePnlPct != null ? `${fmt(sig.outcomePnlPct)}%` : '—'}
                                </td>
                                <td style={{ padding: '7px 12px', color: rMultipleColor(sig.outcomeRMultiple) }}>
                                  {sig.outcomeRMultiple != null ? `${fmt(sig.outcomeRMultiple)}R` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Your Execution panel — only shown if any signals are linked to positions */}
      {linkedSignals.length > 0 && (
        <section style={{ marginBottom: '32px' }}>
          <SectionHeader>Your Execution vs Callers</SectionHeader>
          <ExecutionPanel signals={linkedSignals} callers={callers} />
        </section>
      )}
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

interface ExecutionPanelProps {
  signals: Signal[];
  callers: CallerStats[];
}

function ExecutionPanel({ signals, callers }: ExecutionPanelProps) {
  // Group by callerName and compute: caller's avg P&L on those signals vs user's actual P&L
  // We don't have position P&L here without a separate fetch — show what we have
  const callerGroups = new Map<string, Signal[]>();
  for (const s of signals) {
    const arr = callerGroups.get(s.callerName) ?? [];
    arr.push(s);
    callerGroups.set(s.callerName, arr);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {[...callerGroups.entries()].map(([callerName, callerSigs]) => {
        const callerStats = callers.find((c) => c.callerName === callerName);
        const followed = callerSigs.length;
        const total = callerStats?.totalSignals ?? followed;
        const callerAvg = callerStats?.avgPnlPct;

        const userSigsWithPnl = callerSigs.filter((s) => s.outcomePnlPct != null);
        const userAvg = userSigsWithPnl.length > 0
          ? userSigsWithPnl.reduce((sum, s) => sum + s.outcomePnlPct!, 0) / userSigsWithPnl.length
          : null;

        const gap = callerAvg != null && userAvg != null ? userAvg - callerAvg : null;

        return (
          <div key={callerName} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <span style={{
                width: '24px', height: '24px', borderRadius: '50%',
                background: avatarBg(callerName),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#fff',
              }}>
                {callerInitial(callerName)}
              </span>
              <span style={{ color: '#e6edf3', fontWeight: 700 }}>{callerName}</span>
            </div>
            <p style={{ margin: '0 0 4px', color: '#8b949e', fontSize: '13px' }}>
              You followed <strong style={{ color: '#c9d1d9' }}>{followed}</strong> of {callerName}&apos;s{' '}
              <strong style={{ color: '#c9d1d9' }}>{total}</strong> signals.
            </p>
            {callerAvg != null && (
              <p style={{ margin: '0 0 4px', color: '#8b949e', fontSize: '13px' }}>
                Their signals averaged{' '}
                <strong style={{ color: pnlColor(callerAvg) }}>{fmt(callerAvg)}%</strong>.
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
          </div>
        );
      })}
    </div>
  );
}

const tableRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 16px',
  gap: '8px',
};
