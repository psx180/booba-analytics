'use client';

import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { TOOLTIP_STYLE } from '../types';

export interface SizeScatterPosition {
  kind: string;
  pnl: number | null;
  totalSize: number | null;
  firstEntryTime: string | null;
}

export interface SizeAfterOutcomeScatterProps {
  positions: SizeScatterPosition[];
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface ScatterPoint {
  x: number;  // prior trade P&L
  y: number;  // next trade normalized size
  win: boolean;
}

function computeScatterData(positions: SizeScatterPosition[]): {
  winners: ScatterPoint[];
  losers: ScatterPoint[];
  avgAfterLoss: number;
  avgAfterWin: number;
} {
  const valid = positions
    .filter(
      (p) =>
        p.kind === 'position' &&
        p.pnl != null &&
        p.totalSize != null &&
        p.totalSize > 0 &&
        p.firstEntryTime != null,
    )
    .sort((a, b) => new Date(a.firstEntryTime!).getTime() - new Date(b.firstEntryTime!).getTime());

  if (valid.length < 10) return { winners: [], losers: [], avgAfterLoss: 1, avgAfterWin: 1 };

  const avgSize = valid.reduce((s, p) => s + p.totalSize!, 0) / valid.length;
  if (avgSize === 0) return { winners: [], losers: [], avgAfterLoss: 1, avgAfterWin: 1 };

  const all: ScatterPoint[] = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const curr = valid[i];
    const gap = new Date(curr.firstEntryTime!).getTime() - new Date(prev.firstEntryTime!).getTime();
    if (gap > DAY_MS) continue; // skip cross-session pairs

    all.push({
      x: prev.pnl!,
      y: curr.totalSize! / avgSize,
      win: (curr.pnl ?? 0) > 0,
    });
  }

  const afterLoss = all.filter((p) => p.x < 0);
  const afterWin  = all.filter((p) => p.x > 0);

  const avgAfterLoss =
    afterLoss.length > 0 ? afterLoss.reduce((s, p) => s + p.y, 0) / afterLoss.length : 1;
  const avgAfterWin  =
    afterWin.length  > 0 ? afterWin.reduce((s, p) => s + p.y, 0)  / afterWin.length  : 1;

  return {
    winners: all.filter((p) => p.win),
    losers: all.filter((p) => !p.win),
    avgAfterLoss,
    avgAfterWin,
  };
}

function ScatterTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as ScatterPoint | undefined;
  if (!d) return null;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className={d.win ? 'text-green-400 font-medium mb-1' : 'text-red-400 font-medium mb-1'}>
        {d.win ? 'Winner' : 'Loser'}
      </div>
      <div className="text-[#8b949e]">Prior P&L: ${d.x.toFixed(2)}</div>
      <div className="text-[#8b949e]">Next size: {d.y.toFixed(2)}× avg</div>
    </div>
  );
}

export default function SizeAfterOutcomeScatter({ positions }: SizeAfterOutcomeScatterProps) {
  const { winners, losers, avgAfterLoss, avgAfterWin } = computeScatterData(positions);

  const totalPoints = winners.length + losers.length;

  if (totalPoints < 5) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-[#e6edf3]">Position Sizing After Outcomes</span>
        <div className="flex items-center justify-center h-[220px] text-xs text-[#4a5568] italic">
          Not enough consecutive same-session trade pairs yet
        </div>
      </div>
    );
  }

  const martingale = avgAfterLoss > 1.2;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-[#e6edf3]">Position Sizing After Outcomes</span>
        <div className="flex items-center gap-3 text-[10px] text-[#6e7681]">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500 opacity-70" />Follow-up win</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500 opacity-70" />Follow-up loss</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <ScatterChart margin={{ top: 8, right: 20, left: 0, bottom: 20 }}>
          <CartesianGrid stroke="#21262d" />
          <XAxis
            dataKey="x"
            type="number"
            name="Prior P&L"
            {...axisProps}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            label={{
              value: 'Prior trade P&L ($)',
              position: 'insideBottom',
              offset: -10,
              fontSize: 10,
              fill: '#6e7681',
            }}
          />
          <YAxis
            dataKey="y"
            type="number"
            name="Next Size"
            {...axisProps}
            tickFormatter={(v) => `${v.toFixed(1)}×`}
            label={{
              value: 'Next size (normalized)',
              angle: -90,
              position: 'insideLeft',
              offset: 10,
              fontSize: 10,
              fill: '#6e7681',
            }}
          />
          <Tooltip content={<ScatterTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          {/* Reference lines at zero P&L and 1× size */}
          <ReferenceLine x={0} stroke="#6e7681" strokeDasharray="3 2" />
          <ReferenceLine y={1} stroke="#6e7681" strokeDasharray="3 2" label={{ value: '1×', position: 'right', fontSize: 9, fill: '#6e7681' }} />
          <Scatter data={winners} fill="#22c55e" opacity={0.55} />
          <Scatter data={losers}  fill="#ef4444" opacity={0.55} />
        </ScatterChart>
      </ResponsiveContainer>

      <p className="text-xs text-[#8b949e] leading-relaxed">
        After losses, avg next-trade size:{' '}
        <span className={martingale ? 'text-amber-400 font-medium' : 'text-white'}>
          {avgAfterLoss.toFixed(2)}×
        </span>{' '}
        your baseline. After wins:{' '}
        <span className="text-white">{avgAfterWin.toFixed(2)}×</span>.
        {martingale && (
          <> <span className="text-amber-400">Sizing up after losses may indicate martingale behavior.</span></>
        )}
      </p>
    </div>
  );
}
