'use client';

import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

interface WartAxis {
  score: number;
  method: string;
  details: string;
}

export interface WartResult {
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

interface Props {
  wart: WartResult;
  /** Render a compact radar-only view (~250px, no improvements list). */
  compact?: boolean;
}

const AXIS_LABELS: Record<keyof WartResult['axes'], string> = {
  entry:      'Entry',
  exit:       'Exit',
  risk:       'Risk',
  // Hidden — session concentration is a weak skill dimension, pending redesign.
  // Display-only suppression: stored composite weighting is unchanged.
  timing:     'Timing (TBD)',
  // Renamed — entropy is a measure of decision spread, not a clinical "discipline" claim.
  discipline: 'Decision Consistency',
};

function tierColor(composite: number): string {
  if (composite >= 2)  return 'text-green-400';
  if (composite >= 1)  return 'text-emerald-400';
  if (composite >= 0)  return 'text-amber-400';
  if (composite >= -2) return 'text-orange-400';
  return 'text-red-400';
}

function radarStroke(composite: number): string {
  return composite >= 0 ? '#22c55e' : '#ef4444';
}

function formatComposite(c: number): string {
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}`;
}

const RadarTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as { axis: string; score: number; details: string };
  return (
    <div className="bg-[#1c2128] border border-[#30363d] rounded px-3 py-2 text-xs max-w-[260px]">
      <div className="text-white font-medium mb-1">{p.axis}: {p.score.toFixed(0)}/100</div>
      <div className="text-[#8b949e] leading-relaxed">{p.details}</div>
    </div>
  );
};

export default function WartRadar({ wart, compact = false }: Props) {
  const data = (Object.keys(wart.axes) as (keyof WartResult['axes'])[]).map((key) => ({
    axis:    AXIS_LABELS[key],
    score:   wart.axes[key].score,
    details: wart.axes[key].details,
  }));

  const stroke = radarStroke(wart.composite);
  const fill = stroke;

  if (compact) {
    return (
      <div className="flex flex-col items-center">
        <div className="w-full h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={data} outerRadius="75%">
              <PolarGrid stroke="#30363d" />
              <PolarAngleAxis dataKey="axis" tick={{ fill: '#8b949e', fontSize: 10 }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar
                name="WART"
                dataKey="score"
                stroke={stroke}
                strokeWidth={2}
                fill={fill}
                fillOpacity={0.25}
                isAnimationActive={false}
              />
              <Tooltip content={<RadarTooltip />} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
      {/* Radar */}
      <div className="flex flex-col items-center">
        <div className="w-full h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={data} outerRadius="75%">
              <PolarGrid stroke="#30363d" />
              <PolarAngleAxis
                dataKey="axis"
                tick={{ fill: '#8b949e', fontSize: 12 }}
              />
              <PolarRadiusAxis
                angle={90}
                domain={[0, 100]}
                tick={{ fill: '#6e7681', fontSize: 10 }}
                tickCount={5}
                axisLine={false}
              />
              <Radar
                name="WART"
                dataKey="score"
                stroke={stroke}
                strokeWidth={2}
                fill={fill}
                fillOpacity={0.25}
                isAnimationActive={false}
              />
              <Tooltip content={<RadarTooltip />} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div className="text-center mt-2">
          <div className={`text-3xl font-bold ${tierColor(wart.composite)}`}>
            {formatComposite(wart.composite)}
          </div>
          <div className="text-xs text-[#8b949e] uppercase tracking-widest">
            {wart.tier}
          </div>
          <div className="text-[10px] text-[#6e7681] mt-1">
            Weighted score {wart.weightedScore.toFixed(0)}/100 · {wart.tradeCount} trades
          </div>
        </div>
      </div>

      {/* Axis breakdown + improvements */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[#6e7681] mb-2">
            Axis Breakdown
          </h3>
          <div className="space-y-2">
            {(Object.keys(wart.axes) as (keyof WartResult['axes'])[]).map((key) => {
              const axis = wart.axes[key];
              const barColor =
                axis.score >= 70 ? 'bg-green-500'  :
                axis.score >= 40 ? 'bg-amber-500'  :
                                   'bg-red-500';
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className="w-20 text-xs text-[#8b949e]">{AXIS_LABELS[key]}</div>
                  <div className="flex-1 h-2 bg-[#21262d] rounded overflow-hidden">
                    <div
                      className={`h-full ${barColor}`}
                      style={{ width: `${Math.min(100, Math.max(0, axis.score))}%` }}
                    />
                  </div>
                  <div className="w-10 text-right text-xs font-medium text-white">
                    {axis.score.toFixed(0)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {wart.improvements.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-[#6e7681] mb-2">
              Top Improvements
            </h3>
            <ul className="space-y-2">
              {wart.improvements.map((text, i) => (
                <li
                  key={i}
                  className="text-sm text-[#8b949e] leading-relaxed pl-3 border-l-2 border-[#30363d]"
                >
                  {text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
