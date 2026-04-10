'use client';

import { useState, useEffect } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar, Cell,
} from 'recharts';
import type { AnalyticsChartProps, PositionData } from './types';
import { buildParams, TOOLTIP_STYLE } from './types';

const EFF_BUCKETS = [
  { label: '<0%',     min: -Infinity, max: 0 },
  { label: '0–10%',   min: 0,         max: 0.1 },
  { label: '10–20%',  min: 0.1,       max: 0.2 },
  { label: '20–30%',  min: 0.2,       max: 0.3 },
  { label: '30–40%',  min: 0.3,       max: 0.4 },
  { label: '40–50%',  min: 0.4,       max: 0.5 },
  { label: '50–60%',  min: 0.5,       max: 0.6 },
  { label: '60–70%',  min: 0.6,       max: 0.7 },
  { label: '70–80%',  min: 0.7,       max: 0.8 },
  { label: '80–90%',  min: 0.8,       max: 0.9 },
  { label: '90–100%', min: 0.9,       max: 1.0 },
  { label: '>100%',   min: 1.0,       max: Infinity },
];

function buildHistogram(positions: PositionData[]) {
  const withEff = positions.filter((p) => p.exitEfficiency != null);
  return EFF_BUCKETS.map((b) => ({
    label: b.label,
    count: withEff.filter((p) => (p.exitEfficiency ?? 0) >= b.min && (p.exitEfficiency ?? 0) < b.max).length,
  }));
}

function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const { mfePnl, maePnl, pnl, size } = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className={pnl >= 0 ? 'text-green-400' : 'text-red-400'} style={{ marginBottom: 4, fontWeight: 600 }}>
        {pnl >= 0 ? 'Winner' : 'Loser'}
      </div>
      <div className="text-[#8b949e]">P&L: ${pnl?.toFixed(2)}</div>
      <div className="text-[#8b949e]">MFE: ${mfePnl?.toFixed(2)}</div>
      <div className="text-[#8b949e]">MAE: ${maePnl?.toFixed(2)}</div>
      {size != null && <div className="text-[#8b949e]">Size: {size?.toFixed(4)}</div>}
    </div>
  );
}

function HistTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="text-white font-medium mb-1">{label}</div>
      <div className="text-[#8b949e]">Trades: {payload[0].value}</div>
    </div>
  );
}

function generateSummary(positions: PositionData[]) {
  const withEff = positions.filter((p) => p.exitEfficiency != null && p.exitEfficiency > 0);
  if (withEff.length === 0) return null;
  const avgEff = withEff.reduce((s, p) => s + (p.exitEfficiency ?? 0), 0) / withEff.length;
  const totalLeft = positions.reduce((s, p) => s + (p.moneyLeftOnTable ?? 0), 0);
  const n = positions.filter((p) => p.moneyLeftOnTable != null && p.moneyLeftOnTable > 0).length;
  return {
    avgEff: (avgEff * 100).toFixed(1),
    totalLeft: totalLeft.toFixed(2),
    tradeCount: n,
  };
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

export default function ExitAnalysis({ walletAddress, filters }: AnalyticsChartProps) {
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/analytics/positions?${buildParams(walletAddress, filters)}`)
      .then((r) => r.json())
      .then((d) => setPositions(d.positions ?? []))
      .finally(() => setLoading(false));
  }, [walletAddress, filters]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading exit analysis…
      </div>
    );
  }

  const withMfe = positions.filter((p) => p.mfePnl != null && p.maePnl != null);
  if (withMfe.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No MFE/MAE data yet. Click "Compute Analytics" on the dashboard to compute exit metrics.
      </div>
    );
  }

  const winners = withMfe
    .filter((p) => (p.aggregatePnl ?? 0) >= 0)
    .map((p) => ({ x: p.maePnl ?? 0, y: p.mfePnl ?? 0, z: Math.max(10, Math.min(200, (p.totalSize ?? 1) * 20)), pnl: p.aggregatePnl, mfePnl: p.mfePnl, maePnl: p.maePnl, size: p.totalSize }));
  const losers = withMfe
    .filter((p) => (p.aggregatePnl ?? 0) < 0)
    .map((p) => ({ x: p.maePnl ?? 0, y: p.mfePnl ?? 0, z: Math.max(10, Math.min(200, (p.totalSize ?? 1) * 20)), pnl: p.aggregatePnl, mfePnl: p.mfePnl, maePnl: p.maePnl, size: p.totalSize }));

  const histData = buildHistogram(positions);
  const summary = generateSummary(positions);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* MFE/MAE scatter */}
        <div>
          <p className="text-xs text-[#6e7681] mb-1">MFE vs MAE (each dot = one position)</p>
          <p className="text-[10px] text-[#6e7681] mb-3">X = adverse excursion · Y = favorable excursion · size = position size</p>
          <ResponsiveContainer width="100%" height={240}>
            <ScatterChart margin={{ top: 5, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid stroke="#21262d" />
              <XAxis
                dataKey="x"
                type="number"
                name="MAE"
                {...axisProps}
                label={{ value: 'MAE ($)', position: 'insideBottom', offset: -12, fill: '#6e7681', fontSize: 11 }}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
              />
              <YAxis
                dataKey="y"
                type="number"
                name="MFE"
                {...axisProps}
                width={60}
                label={{ value: 'MFE ($)', angle: -90, position: 'insideLeft', offset: 10, fill: '#6e7681', fontSize: 11 }}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
              />
              <ZAxis dataKey="z" range={[20, 300]} />
              <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#30363d' }} />
              {winners.length > 0 && (
                <Scatter name="Winners" data={winners} fill="#22c55e" fillOpacity={0.65} />
              )}
              {losers.length > 0 && (
                <Scatter name="Losers" data={losers} fill="#ef4444" fillOpacity={0.65} />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Exit efficiency histogram */}
        <div>
          <p className="text-xs text-[#6e7681] mb-3">Exit Efficiency Distribution</p>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={histData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
              <XAxis dataKey="label" {...axisProps} angle={-45} textAnchor="end" height={50} interval={0} tick={{ fill: '#6e7681', fontSize: 10 }} />
              <YAxis {...axisProps} width={35} allowDecimals={false} />
              <Tooltip content={<HistTooltip />} cursor={TOOLTIP_STYLE.cursor} />
              <Bar dataKey="count" fill="#3b82f6" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {summary && (
        <p className="text-sm text-[#8b949e] bg-[#0d1117] rounded-lg px-4 py-3 border border-[#21262d]">
          Average exit efficiency: <span className="text-white">{summary.avgEff}%</span> — you capture{' '}
          {summary.avgEff}% of available moves.{' '}
          {Number(summary.totalLeft) > 0 && (
            <>
              Total money left on table:{' '}
              <span className="text-amber-400">${Number(summary.totalLeft).toLocaleString()}</span> across{' '}
              <span className="text-white">{summary.tradeCount}</span> trades.
            </>
          )}
        </p>
      )}
    </div>
  );
}
