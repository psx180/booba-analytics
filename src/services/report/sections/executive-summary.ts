import type { ReportData } from '../data';
import type { ExecutiveSummarySection } from '../types';

/**
 * Executive summary — composite score, Elo, headline metrics, and the top
 * strengths / weaknesses / recommendations distilled from the convergence
 * themes plus WART axis improvements.
 */
export function generateExecutiveSummary(data: ReportData): ExecutiveSummarySection | null {
  if (data.closedPositions.length === 0) return null;

  const perf = data.performance.data ?? {};
  const wart = data.wartResult;
  // Elo intentionally not read — hidden from the section per the cleanup pass.

  const axes: Record<string, number> = {};
  for (const [name, axis] of Object.entries(wart.axes ?? {})) {
    if (axis && typeof axis.score === 'number') axes[name] = round(axis.score, 1);
  }

  const strengths = collectStrengths(data);
  const weaknesses = collectWeaknesses(data);
  const recommendations = collectRecommendations(data);

  return {
    compositeScore: {
      score: round(wart.composite, 2),
      tier: wart.tier ?? '—',
      axes,
    },
    // Hidden — Elo requires population calibration to be meaningful
    eloRating: null,
    headlineMetrics: {
      sharpe: data.riskMetrics.sharpeRatio,
      sortino: data.riskMetrics.sortinoRatio,
      calmar: data.riskMetrics.calmarRatio,
      winRate: round((perf.winRate as number) ?? 0, 4),
      expectancy: round((perf.expectancy as number) ?? 0, 2),
      profitFactor: round((perf.profitFactor as number) ?? 0, 2),
    },
    topStrengths: strengths,
    topWeaknesses: weaknesses,
    recommendations,
  };
}

function collectStrengths(data: ReportData): string[] {
  const out: string[] = [];
  if (data.convergence.biggestStrength) {
    out.push(data.convergence.biggestStrength.headline);
  }
  for (const t of data.convergence.themes ?? []) {
    if (t === data.convergence.biggestStrength) continue;
    if (t.severity === 'positive') out.push(t.headline);
  }
  return out.slice(0, 3);
}

function collectWeaknesses(data: ReportData): string[] {
  const out: string[] = [];
  if (data.convergence.biggestLeak) out.push(data.convergence.biggestLeak.headline);
  for (const t of data.convergence.themes ?? []) {
    if (t === data.convergence.biggestLeak) continue;
    if (t.severity === 'critical' || t.severity === 'warning') out.push(t.headline);
  }
  return out.slice(0, 3);
}

function collectRecommendations(data: ReportData): string[] {
  const out: string[] = [];
  if (data.convergence.weeklyFocus) out.push(data.convergence.weeklyFocus.prescription);
  for (const imp of data.wartResult.improvements ?? []) {
    if (typeof imp === 'string' && imp.length > 0) out.push(imp);
  }
  // De-dup while preserving order; cap at 5 so the cover page doesn't bloat.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const r of out) {
    if (seen.has(r)) continue;
    seen.add(r);
    dedup.push(r);
    if (dedup.length === 5) break;
  }
  return dedup;
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
