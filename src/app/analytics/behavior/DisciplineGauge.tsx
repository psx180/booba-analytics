'use client';

import { LineChart, Line, ResponsiveContainer } from 'recharts';

export interface DisciplineGaugeProps {
  compositeScore: number;
  rollingSeries: { date: string; score: number }[];
}

// ── SVG gauge constants ──────────────────────────────────────────────────────
const CX = 110;
const CY = 105;
const R  = 80;
const SW = 14; // stroke width

/** Convert angle in degrees (standard math, 0° = right, 90° = up) to SVG x,y. */
function pt(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + radius * Math.cos(rad),
    y: CY - radius * Math.sin(rad),
  };
}

/**
 * SVG arc path going counterclockwise (sweep=0) from startDeg to endDeg.
 * Both angles use standard math convention (decreasing = counterclockwise).
 * Score 0 maps to 180° (left), score 100 maps to 0° (right).
 */
function arcPath(startDeg: number, endDeg: number, r = R): string {
  const s = pt(startDeg, r);
  const e = pt(endDeg, r);
  // Arcs are all ≤ 180°, so large-arc-flag is always 0.
  return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${r} ${r} 0 0 0 ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
}

/** Map a 0-100 score to the corresponding gauge angle (180°→0°). */
function scoreToAngle(score: number): number {
  return 180 - score * 1.8;
}

export default function DisciplineGauge({ compositeScore, rollingSeries }: DisciplineGaugeProps) {
  const clampedScore = Math.max(0, Math.min(100, compositeScore));
  const scoreAngle   = scoreToAngle(clampedScore);

  // Color for the active portion and needle
  const scoreColor =
    clampedScore >= 70 ? '#22c55e'
    : clampedScore >= 40 ? '#eab308'
    : '#ef4444';

  // Per-zone active end angles (zones go from high → low angle as score increases)
  const redEnd    = clampedScore <= 40 ? scoreAngle : 108; // 0–40 zone ends at 108°
  const yellowEnd = clampedScore <= 70 ? scoreAngle : 54;  // 40–70 zone ends at 54°
  const greenEnd  = scoreAngle;                            // 70–100 zone ends at current

  const needleTip = pt(scoreAngle, R * 0.74);

  return (
    <div className="flex flex-col items-center">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-0.5">
        Trading Discipline
      </div>

      {/* Gauge SVG */}
      <svg width={220} height={130} viewBox={`0 0 220 130`}>
        {/* ── Background zone arcs (dimmed) ─────────────────────── */}
        <path d={arcPath(180, 108)} fill="none" stroke="#ef4444" strokeWidth={SW} opacity={0.18} strokeLinecap="butt" />
        <path d={arcPath(108,  54)} fill="none" stroke="#eab308" strokeWidth={SW} opacity={0.18} strokeLinecap="butt" />
        <path d={arcPath( 54,   0)} fill="none" stroke="#22c55e" strokeWidth={SW} opacity={0.18} strokeLinecap="butt" />

        {/* ── Active zone arcs (full opacity, segmented by zone) ── */}
        {clampedScore > 0 && (
          <path
            d={arcPath(180, redEnd)}
            fill="none" stroke="#ef4444" strokeWidth={SW}
            opacity={0.85} strokeLinecap="butt"
          />
        )}
        {clampedScore > 40 && (
          <path
            d={arcPath(108, yellowEnd)}
            fill="none" stroke="#eab308" strokeWidth={SW}
            opacity={0.85} strokeLinecap="butt"
          />
        )}
        {clampedScore > 70 && (
          <path
            d={arcPath(54, greenEnd)}
            fill="none" stroke="#22c55e" strokeWidth={SW}
            opacity={0.85} strokeLinecap="butt"
          />
        )}

        {/* ── Zone boundary tick marks ─────────────────────────── */}
        {[108, 54].map((deg) => {
          const inner = pt(deg, R - SW / 2 - 2);
          const outer = pt(deg, R + SW / 2 + 2);
          return (
            <line
              key={deg}
              x1={inner.x} y1={inner.y}
              x2={outer.x} y2={outer.y}
              stroke="#0d1117" strokeWidth={2}
            />
          );
        })}

        {/* ── Zone labels ──────────────────────────────────────── */}
        {(() => {
          const p40 = pt(126, R + SW / 2 + 10);
          const p70 = pt(74,  R + SW / 2 + 10);
          return (
            <>
              <text x={p40.x} y={p40.y} textAnchor="middle" fontSize={8} fill="#6e7681">40</text>
              <text x={p70.x} y={p70.y} textAnchor="middle" fontSize={8} fill="#6e7681">70</text>
            </>
          );
        })()}

        {/* ── Needle ───────────────────────────────────────────── */}
        <line
          x1={CX} y1={CY}
          x2={needleTip.x.toFixed(2)} y2={needleTip.y.toFixed(2)}
          stroke="#e6edf3" strokeWidth={2} strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={5} fill="#e6edf3" />

        {/* ── Score label ──────────────────────────────────────── */}
        <text x={CX} y={CY + 20} textAnchor="middle" fontSize={22} fontWeight="bold" fill={scoreColor}>
          {Math.round(clampedScore)}
        </text>
        <text x={CX} y={CY + 33} textAnchor="middle" fontSize={10} fill="#6e7681">
          / 100
        </text>
      </svg>

      {/* ── Rolling sparkline ─────────────────────────────────── */}
      {rollingSeries.length >= 4 && (
        <div className="w-full px-2">
          <div className="text-[9px] text-[#6e7681] text-center mb-0.5">30-trade rolling trend</div>
          <ResponsiveContainer width="100%" height={32}>
            <LineChart data={rollingSeries} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
              <Line
                type="monotone"
                dataKey="score"
                stroke={scoreColor}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
