import * as ss from 'simple-statistics';

export interface SessionDecayPosition {
  kind: string;
  pnl: number | null;
  firstEntryTime: string | null;
}

export interface DecayPoint {
  trade: number;
  avgPnl: number;
  count: number;
}

export interface DecaySeriesResult {
  series: DecayPoint[];
  optimalStop: number | null;
  avgDeclineAfter: number;
  savingsPerSession: number;
  isFatigueSignificant: boolean;
  slope: number;
  tStat: number;
}

const EMPTY: DecaySeriesResult = {
  series: [],
  optimalStop: null,
  avgDeclineAfter: 0,
  savingsPerSession: 0,
  isFatigueSignificant: false,
  slope: 0,
  tStat: 0,
};

export function computeDecaySeries(positions: SessionDecayPosition[]): DecaySeriesResult {
  const valid = positions.filter(
    (p) => p.kind === 'position' && p.pnl != null && p.firstEntryTime != null,
  );
  if (valid.length < 10) return EMPTY;

  const byDay = new Map<string, { pnl: number; time: number }[]>();
  for (const p of valid) {
    const day = p.firstEntryTime!.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push({ pnl: p.pnl!, time: new Date(p.firstEntryTime!).getTime() });
    byDay.set(day, arr);
  }

  for (const arr of byDay.values()) arr.sort((a, b) => a.time - b.time);

  const byTradeNum = new Map<number, number[]>();
  for (const arr of byDay.values()) {
    arr.forEach(({ pnl }, idx) => {
      const n = idx + 1;
      const existing = byTradeNum.get(n) ?? [];
      existing.push(pnl);
      byTradeNum.set(n, existing);
    });
  }

  const counts = Array.from(byTradeNum.values()).map((v) => v.length);
  if (counts.length === 0) return EMPTY;
  const maxCount = Math.max(...counts);
  const minRequired = Math.max(5, Math.floor(maxCount * 0.15));

  const series: DecayPoint[] = Array.from(byTradeNum.entries())
    .filter(([, pnls]) => pnls.length >= minRequired)
    .sort(([a], [b]) => a - b)
    .map(([n, pnls]) => ({
      trade: n,
      avgPnl: pnls.reduce((s, v) => s + v, 0) / pnls.length,
      count: pnls.length,
    }));

  if (series.length < 2) {
    return { ...EMPTY, series };
  }

  let maxAvg = -Infinity;
  let optimalStop = series[0].trade;
  for (const pt of series) {
    if (pt.avgPnl > maxAvg) {
      maxAvg = pt.avgPnl;
      optimalStop = pt.trade;
    }
  }

  const afterOptimal = series.filter((pt) => pt.trade > optimalStop);
  const avgDeclineAfter = afterOptimal.length > 0
    ? afterOptimal.reduce((s, pt) => s + pt.avgPnl, 0) / afterOptimal.length
    : 0;
  const savingsPerSession = avgDeclineAfter < 0 ? Math.abs(avgDeclineAfter) * afterOptimal.length : 0;

  let slope = 0;
  let tStat = 0;
  let isFatigueSignificant = false;

  if (series.length >= 3) {
    const regData = series.map((pt) => [pt.trade, pt.avgPnl] as [number, number]);
    const reg = ss.linearRegression(regData);
    const regLine = ss.linearRegressionLine(reg);

    const n = regData.length;
    const xMean = regData.reduce((s, [x]) => s + x, 0) / n;
    const ssx = regData.reduce((s, [x]) => s + (x - xMean) ** 2, 0);
    const residuals = regData.map(([x, y]) => y - regLine(x));
    const sse = residuals.reduce((s, r) => s + r * r, 0);
    const slopeStdErr = ssx > 0 && n > 2 ? Math.sqrt(sse / ((n - 2) * ssx)) : Infinity;
    slope = reg.m;
    tStat = slopeStdErr > 0 && Number.isFinite(slopeStdErr) ? reg.m / slopeStdErr : 0;
    isFatigueSignificant = n > 3 && Math.abs(tStat) > 2.0 && reg.m < 0;
  }

  return {
    series,
    optimalStop,
    avgDeclineAfter,
    savingsPerSession,
    isFatigueSignificant,
    slope,
    tStat,
  };
}
