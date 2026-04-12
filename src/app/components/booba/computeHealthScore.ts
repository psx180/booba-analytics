export function computeHealthScore(data: {
  wartComposite?: number;       // -5 to +5
  tiltScore?: number;           // 0-100 (higher = more tilted = worse)
  eloTrend?: string;
  recentWinRate?: number;       // 0-1 fraction
  currentDrawdownPct?: number;  // negative number, e.g. -25 means 25% drawdown
}): number {
  let score = 50;

  // WART: each point = ±5, capped at ±25
  if (data.wartComposite !== undefined) {
    score += Math.max(-25, Math.min(25, data.wartComposite * 5));
  }

  // Tilt: above 50 starts penalizing, max -25
  if (data.tiltScore !== undefined && data.tiltScore > 50) {
    score -= Math.min(25, (data.tiltScore - 50) * 0.5);
  }

  // Elo trend
  if (data.eloTrend === 'improving') score += 10;
  else if (data.eloTrend === 'declining') score -= 10;

  // Win rate
  if (data.recentWinRate !== undefined) {
    if (data.recentWinRate > 0.55) score += 10;
    else if (data.recentWinRate < 0.35) score -= 10;
  }

  // Drawdown: worse than -20% is a penalty
  if (data.currentDrawdownPct !== undefined && data.currentDrawdownPct < -20) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
