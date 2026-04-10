'use client';

import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, Legend,
} from 'recharts';
import type { AnalyticsChartProps, PerformanceStats } from './types';
import { buildParams, REGIME_LABELS, REGIME_COLORS, REGIME_BADGE, TOOLTIP_STYLE } from './types';

type RegimeBreakdown = Record<string, PerformanceStats>;

function PnlTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const { totalPnl, winRate, tradeCount, expectancy } = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="font-medium text-white mb-1">{REGIME_LABELS[label] ?? label}</div>
      <div className={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
        P&L: {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
      </div>
      <div className="text-[#8b949e]">Win rate: {(winRate * 100).toFixed(1)}%</div>
      <div className="text-[#8b949e]">Trades: {tradeCount}</div>
      <div className="text-[#8b949e]">Expectancy: ${expectancy.toFixed(2)}</div>
    </div>
  );
}

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const { name, value, percent } = payload[0];
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="font-medium text-white mb-1">{REGIME_LABELS[name] ?? name}</div>
      <div className="text-[#8b949e]">{value} trades ({(percent * 100).toFixed(1)}%)</div>
    </div>
  );
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

export default function RegimePerformance({ walletAddress, filters }: AnalyticsChartProps) {
  const [breakdown, setBreakdown] = useState<RegimeBreakdown>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const p = buildParams(walletAddress, filters);
    p.set('groupBy', 'regime');
    fetch(`/api/analytics/breakdown?${p}`)
      .then((r) => r.json())
      .then((d) => setBreakdown(d.breakdowns?.regime ?? {}))
      .finally(() => setLoading(false));
  }, [walletAddress, filters]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading regime performance…
      </div>
    );
  }

  const entries = Object.entries(breakdown).filter(([, s]) => s.tradeCount > 0);
  if (entries.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No regime data yet. Ensure trades have regime tags assigned.
      </div>
    );
  }

  const barData = entries.map(([regime, stats]) => ({
    name: regime,
    totalPnl: stats.totalPnl,
    winRate: stats.winRate,
    tradeCount: stats.tradeCount,
    expectancy: stats.expectancy,
  }));

  const pieData = entries.map(([regime, stats]) => ({
    name: regime,
    value: stats.tradeCount,
  }));

  const totalTrades = entries.reduce((s, [, st]) => s + st.tradeCount, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* P&L bar chart */}
        <div>
          <p className="text-xs text-[#6e7681] mb-3">Total P&L by Regime</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
              <XAxis
                dataKey="name"
                {...axisProps}
                tickFormatter={(v) => REGIME_LABELS[v] ?? v}
                interval={0}
                angle={-20}
                textAnchor="end"
                height={50}
                tick={{ fill: '#6e7681', fontSize: 10 }}
              />
              <YAxis {...axisProps} width={60} tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip content={<PnlTooltip />} cursor={TOOLTIP_STYLE.cursor} />
              <Bar dataKey="totalPnl" radius={[3, 3, 0, 0]}>
                {barData.map((entry, i) => (
                  <Cell key={i} fill={REGIME_COLORS[entry.name] ?? '#374151'} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Trade distribution pie */}
        <div>
          <p className="text-xs text-[#6e7681] mb-3">Trade Distribution by Regime</p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                innerRadius={40}
              >
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={REGIME_COLORS[entry.name] ?? '#374151'} fillOpacity={0.85} />
                ))}
              </Pie>
              <Tooltip content={<PieTooltip />} />
              <Legend
                formatter={(value) => (
                  <span style={{ color: '#8b949e', fontSize: 11 }}>{REGIME_LABELS[value] ?? value}</span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Detailed table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
              <th className="pb-2 pr-4">Regime</th>
              <th className="pb-2 pr-4">Trades</th>
              <th className="pb-2 pr-4">% of All</th>
              <th className="pb-2 pr-4">Total P&L</th>
              <th className="pb-2 pr-4">Win Rate</th>
              <th className="pb-2 pr-4">Expectancy</th>
              <th className="pb-2">Profit Factor</th>
            </tr>
          </thead>
          <tbody>
            {entries
              .sort(([, a], [, b]) => b.totalPnl - a.totalPnl)
              .map(([regime, stats]) => {
                const badge = REGIME_BADGE[regime];
                return (
                  <tr key={regime} className="border-t border-[#21262d] text-sm hover:bg-[#1c2128] transition-colors">
                    <td className="py-2.5 pr-4">
                      {badge ? (
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>
                          {REGIME_LABELS[regime] ?? regime}
                        </span>
                      ) : (
                        <span className="text-[#6e7681]">{REGIME_LABELS[regime] ?? regime}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-[#8b949e]">{stats.tradeCount}</td>
                    <td className="py-2.5 pr-4 text-[#8b949e]">
                      {totalTrades > 0 ? `${((stats.tradeCount / totalTrades) * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className={`py-2.5 pr-4 font-medium ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
                    </td>
                    <td className="py-2.5 pr-4 text-[#8b949e]">
                      {(stats.winRate * 100).toFixed(1)}%
                    </td>
                    <td className={`py-2.5 pr-4 ${stats.expectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}
                    </td>
                    <td className={`py-2.5 ${stats.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
