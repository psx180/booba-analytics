'use client';

import { useEffect, useState } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import type { CallerAnalytics } from '@/services/signals/caller-analytics';

// ── Helpers ───────────────────────────────────────────────────────────────────

function callerInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function avatarBg(name: string): string {
  const colors = ['#1f6feb', '#238636', '#9e6a03', '#8250df', '#bf4b8a', '#0d6efd'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffff;
  return colors[Math.abs(hash) % colors.length];
}

function fmt(n: number, digits = 2): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

function fmtPct(n: number): string {
  return `${fmt(n, 1)}%`;
}

function pnlColor(n: number): string {
  return n >= 0 ? '#3fb950' : '#f85149';
}

function eloBadgeColor(tier: string): { bg: string; color: string } {
  if (tier === 'Advanced' || tier === 'Expert' || tier === 'Grandmaster') {
    return { bg: 'rgba(35,134,54,0.2)', color: '#3fb950' };
  }
  if (tier === 'Intermediate') {
    return { bg: 'rgba(210,153,34,0.2)', color: '#d29922' };
  }
  return { bg: 'rgba(218,54,51,0.2)', color: '#f85149' };
}

function axisBarColor(score: number): string {
  if (score >= 65) return '#3fb950';
  if (score >= 40) return '#d29922';
  return '#f85149';
}

function formatRegimeLabel(r: string): string {
  return r
    .replace('trending_low_vol', 'Trending / Low Vol')
    .replace('trending_high_vol', 'Trending / High Vol')
    .replace('ranging_low_vol', 'Ranging / Low Vol')
    .replace('ranging_high_vol', 'Ranging / High Vol')
    .replace('transitional', 'Transitional')
    .replace('unknown', 'Unknown');
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px',
      padding: '14px 18px',
      flex: 1,
    }}>
      <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: color ?? '#e6edf3', fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}

function SkeletonBox({ h, w = '100%' }: { h: number | string; w?: string }) {
  return (
    <div style={{
      height: typeof h === 'number' ? `${h}px` : h,
      width: w,
      background: '#21262d',
      borderRadius: '6px',
      animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  );
}

const WART_AXES = [
  { key: 'entryScore', label: 'Entry' },
  { key: 'exitScore', label: 'Exit' },
  { key: 'riskScore', label: 'Risk' },
  { key: 'timingScore', label: 'Timing' },
] as const;

function WartBars({ analytics }: { analytics: CallerAnalytics }) {
  const data = WART_AXES.map(({ key, label }) => ({
    label,
    score: analytics[key],
  }));

  return (
    <div style={{ height: '180px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={{ fill: '#6e7681', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: '#8b949e', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            contentStyle={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: '6px', fontSize: '12px' }}
            formatter={(value: number) => [`${value.toFixed(0)}/100`, 'Score']}
          />
          <Bar dataKey="score" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.label} fill={axisBarColor(d.score)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EquityChart({ equityCurve }: { equityCurve: CallerAnalytics['equityCurve'] }) {
  if (equityCurve.length === 0) return null;
  const finalBalance = equityCurve[equityCurve.length - 1].balance;
  const lineColor = finalBalance >= 0 ? '#22c55e' : '#ef4444';
  const gradientId = 'callerEquityGrad';

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload as { date: string; balance: number };
    const d = new Date(point.date);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return (
      <div style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: '6px', padding: '8px 12px', fontSize: '12px' }}>
        <div style={{ color: '#8b949e', marginBottom: '4px' }}>{dateStr}</div>
        <div style={{ color: pnlColor(point.balance), fontWeight: 700 }}>
          {fmtPct(point.balance)}
        </div>
      </div>
    );
  };

  return (
    <div style={{ height: '180px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={equityCurve} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={lineColor} stopOpacity={0.15} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => {
              const d = new Date(v);
              return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }}
            tick={{ fill: '#6e7681', fontSize: 10 }}
            axisLine={{ stroke: '#30363d' }}
            tickLine={false}
            minTickGap={50}
          />
          <YAxis
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            tick={{ fill: '#6e7681', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="balance"
            stroke={lineColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, fill: lineColor, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BreakdownTable({
  rows,
  keyLabel,
  keyAccessor,
}: {
  rows: { winRate: number; avgPnl: number; count: number; [k: string]: any }[];
  keyLabel: string;
  keyAccessor: string;
}) {
  if (rows.length === 0) {
    return <div style={{ color: '#484f58', fontSize: '12px', padding: '8px 0' }}>No data</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr style={{ color: '#6e7681', borderBottom: '1px solid #30363d' }}>
          {[keyLabel, 'W/R', 'Avg P&L', '#'].map((h) => (
            <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row[keyAccessor]} style={{ borderBottom: '1px solid #21262d' }}>
            <td style={{ padding: '6px 8px', color: '#c9d1d9', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {keyAccessor === 'regime' ? formatRegimeLabel(row[keyAccessor]) : row[keyAccessor]}
            </td>
            <td style={{ padding: '6px 8px', color: pnlColor(row.winRate - 0.5), fontWeight: 600 }}>
              {(row.winRate * 100).toFixed(0)}%
            </td>
            <td style={{ padding: '6px 8px', color: pnlColor(row.avgPnl), fontWeight: 600 }}>
              {fmtPct(row.avgPnl)}
            </td>
            <td style={{ padding: '6px 8px', color: '#8b949e' }}>{row.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnalyticsContent({ analytics }: { analytics: CallerAnalytics }) {
  const { color: eloColor, bg: eloBg } = eloBadgeColor(analytics.eloTier);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Stat cards */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <StatCard
          label="Win Rate"
          value={`${(analytics.winRate * 100).toFixed(0)}%`}
          color={analytics.winRate >= 0.5 ? '#3fb950' : '#f85149'}
        />
        <StatCard
          label="Expectancy"
          value={fmtPct(analytics.expectancy)}
          color={pnlColor(analytics.expectancy)}
        />
        <StatCard
          label="Profit Factor"
          value={analytics.profitFactor === 999 ? '∞' : analytics.profitFactor.toFixed(2)}
          color={analytics.profitFactor >= 1 ? '#3fb950' : '#f85149'}
        />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '10px' }}>
            Equity Curve
          </div>
          <EquityChart equityCurve={analytics.equityCurve} />
        </div>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '10px' }}>
            Axis Scores
          </div>
          <WartBars analytics={analytics} />
        </div>
      </div>

      {/* Breakdown tables */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '10px' }}>
            Regime Breakdown
          </div>
          <BreakdownTable rows={analytics.regimeBreakdown} keyLabel="Regime" keyAccessor="regime" />
        </div>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '10px' }}>
            Asset Breakdown
          </div>
          <BreakdownTable rows={analytics.assetBreakdown} keyLabel="Asset" keyAccessor="asset" />
        </div>
      </div>

      {/* Streak info */}
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px', display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '4px' }}>
            Longest Win Streak
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#3fb950', fontFamily: 'monospace' }}>
            {analytics.longestWinStreak}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '4px' }}>
            Longest Loss Streak
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f85149', fontFamily: 'monospace' }}>
            {analytics.longestLoseStreak}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6e7681', marginBottom: '4px' }}>
            Current Streak
          </div>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 12px',
            borderRadius: '20px',
            background: analytics.currentStreak.type === 'win' ? 'rgba(35,134,54,0.2)' : 'rgba(218,54,51,0.2)',
            color: analytics.currentStreak.type === 'win' ? '#3fb950' : '#f85149',
            fontWeight: 700,
            fontSize: '14px',
          }}>
            {analytics.currentStreak.type === 'win' ? '▲' : '▼'}
            {analytics.currentStreak.count} {analytics.currentStreak.type}
            {analytics.currentStreak.count !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#6e7681' }}>
          avg win: <span style={{ color: '#3fb950', fontWeight: 600 }}>{fmtPct(analytics.avgWin)}</span>
          {' · '}
          avg loss: <span style={{ color: '#f85149', fontWeight: 600 }}>{fmtPct(analytics.avgLoss)}</span>
        </div>
      </div>
    </div>
  );
}

function SkeletonContent() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <SkeletonBox h={72} />
        <SkeletonBox h={72} />
        <SkeletonBox h={72} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <SkeletonBox h={220} />
        <SkeletonBox h={220} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <SkeletonBox h={140} />
        <SkeletonBox h={140} />
      </div>
      <SkeletonBox h={64} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface CallerAnalyticsModalProps {
  callerName: string;
  onClose: () => void;
}

export default function CallerAnalyticsModal({ callerName, onClose }: CallerAnalyticsModalProps) {
  const [analytics, setAnalytics] = useState<CallerAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [notEnoughData, setNotEnoughData] = useState(false);
  const authFetch = useAuthFetch();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setNotEnoughData(false);
      setAnalytics(null);
      try {
        const res = await authFetch(
          `/api/signals/caller-analytics?caller=${encodeURIComponent(callerName)}`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.analytics === null) {
          setNotEnoughData(true);
        } else {
          setAnalytics(data.analytics);
        }
      } catch {
        if (!cancelled) setNotEnoughData(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [callerName, authFetch]);

  // Keyboard: close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { color: eloColor, bg: eloBg } = analytics
    ? eloBadgeColor(analytics.eloTier)
    : { color: '#6e7681', bg: '#21262d' };

  return (
    <>
      {/* pulse animation */}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.72)',
          zIndex: 50,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: '40px 24px',
          overflowY: 'auto',
        }}
        onClick={onClose}
      >
        {/* Modal */}
        <div
          style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '900px',
            padding: '24px',
            color: '#c9d1d9',
            fontFamily: 'monospace',
            position: 'relative',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              {/* Avatar */}
              <div style={{
                width: '44px',
                height: '44px',
                borderRadius: '50%',
                background: avatarBg(callerName),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '18px',
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}>
                {callerInitial(callerName)}
              </div>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#e6edf3' }}>{callerName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  {analytics && (
                    <>
                      <span style={{
                        padding: '2px 10px',
                        borderRadius: '20px',
                        fontSize: '11px',
                        fontWeight: 700,
                        background: eloBg,
                        color: eloColor,
                        letterSpacing: '0.04em',
                      }}>
                        {analytics.eloTier} · {analytics.eloRating.toFixed(0)} Elo
                      </span>
                      <span style={{ color: '#6e7681', fontSize: '12px' }}>
                        {analytics.totalSignals} signals
                      </span>
                    </>
                  )}
                  {loading && (
                    <div style={{ width: '120px' }}>
                      <SkeletonBox h={20} />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Close button */}
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid #30363d',
                borderRadius: '6px',
                color: '#8b949e',
                fontSize: '14px',
                cursor: 'pointer',
                padding: '4px 10px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          {loading ? (
            <SkeletonContent />
          ) : notEnoughData ? (
            <div style={{
              background: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '8px',
              padding: '40px',
              textAlign: 'center',
              color: '#8b949e',
              fontSize: '14px',
            }}>
              Not enough resolved signals for analytics. Need at least 5.
            </div>
          ) : analytics ? (
            <AnalyticsContent analytics={analytics} />
          ) : null}
        </div>
      </div>
    </>
  );
}
