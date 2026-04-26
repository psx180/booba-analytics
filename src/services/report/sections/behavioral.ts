import type { Insight, StatisticalTest } from '../../analytics/types';
import type { ReportData } from '../data';
import type { BehavioralSection } from '../types';
import { evaluateSyndromes } from '../../analytics/syndromes/syndrome-detector';

const MODULE_LABELS: Record<string, string> = {
  'streak-behavior': 'Serial dependence',
  'revenge-trading': 'Revenge trading',
  'disposition': 'Disposition effect',
  'overtrading': 'Overtrading',
  'session-fatigue': 'Session fatigue',
  'tilt-episodes': 'Tilt episodes',
  'time-of-day-edge': 'Time-of-day edge',
};

export function generateBehavioral(data: ReportData): BehavioralSection | null {
  if (data.closedPositions.length === 0) return null;

  const byModule = new Map<string, Insight>();
  for (const insight of data.storedInsights) byModule.set(insight.module, insight);

  const serialDependence = deriveSerialDependence(byModule.get('streak-behavior'));
  const revengeTradingSignals = deriveRevenge(byModule.get('revenge-trading'));
  const dispositionEffect = deriveDisposition(byModule.get('disposition'));
  const tiltEpisodes = deriveTilt(data);
  const sessionFatigue = deriveSessionFatigue(byModule.get('session-fatigue'));
  const overtrading = deriveOvertrading(byModule.get('overtrading'));
  const insights = data.storedInsights.map((i) => insightSummary(i));
  const syndromes = deriveSyndromes(data);

  return {
    summary: buildSummary({
      serialDependence,
      revengeTradingSignals,
      dispositionEffect,
      tiltEpisodes,
      sessionFatigue,
      overtrading,
      insights,
    }),
    serialDependence,
    revengeTradingSignals,
    dispositionEffect,
    tiltEpisodes,
    sessionFatigue,
    overtrading,
    insights,
    syndromes,
  };
}

function deriveSyndromes(data: ReportData): BehavioralSection['syndromes'] {
  if (data.storedInsights.length === 0) return null;
  const report = evaluateSyndromes({
    insights: data.storedInsights,
    walkForward: data.walkForward,
    regimeBreakdown: data.regimeBreakdown,
  });
  return {
    results: report.syndromes.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      confidence: s.confidence,
      presentCount: s.presentCount,
      totalCount: s.totalCount,
      summary: s.summary,
      intervention: s.intervention,
      requiredSignals: s.requiredSignals.map((sig) => ({
        name: sig.name,
        displayName: sig.displayName,
        status: sig.status,
        description: sig.description,
        pValue: sig.pValue,
      })),
      supportingSignals: s.supportingSignals.map((sig) => ({
        name: sig.name,
        displayName: sig.displayName,
        status: sig.status,
        description: sig.description,
        pValue: sig.pValue,
      })),
      contradictingSignals: s.contradictingSignals.map((sig) => ({
        name: sig.name,
        displayName: sig.displayName,
        status: sig.status,
        description: sig.description,
        pValue: sig.pValue,
      })),
    })),
    dominantSyndrome: report.dominantSyndrome?.name ?? null,
    overallAssessment: report.overallAssessment,
  };
}

// Friendly labels we already mention via the named-pattern accessors —
// matched against `insightSummary().name` to dedupe so the summary doesn't
// list "revenge trading" twice when the detector also surfaces it as a
// generic insight.
const NAMED_PATTERN_LABELS = new Set([
  'Revenge trading',
  'Disposition effect',
  'Serial dependence',
  'Overtrading',
  'Session fatigue',
  'Tilt episodes',
]);

function buildSummary(s: {
  serialDependence: BehavioralSection['serialDependence'];
  revengeTradingSignals: BehavioralSection['revengeTradingSignals'];
  dispositionEffect: BehavioralSection['dispositionEffect'];
  tiltEpisodes: BehavioralSection['tiltEpisodes'];
  sessionFatigue: BehavioralSection['sessionFatigue'];
  overtrading: BehavioralSection['overtrading'];
  insights: BehavioralSection['insights'];
}): string {
  const flags: string[] = [];

  if (s.revengeTradingSignals.detected) flags.push('revenge trading');
  if (s.dispositionEffect?.detected) flags.push('a disposition effect (holding losers, cutting winners)');
  if (s.serialDependence?.isSignificant) flags.push('serial dependence between consecutive trades');
  if (s.overtrading?.isSignificant) flags.push('overtrading on heavy days');
  if (s.sessionFatigue?.isSignificant) flags.push('session fatigue');

  // Pull in any other behavioural detector that came back significant —
  // skip the ones we already named explicitly above so we don't repeat
  // ourselves.
  for (const ins of s.insights) {
    if (!ins.isSignificant) continue;
    if (NAMED_PATTERN_LABELS.has(ins.name)) continue;
    flags.push(ins.name.toLowerCase());
  }

  // Tilt episodes are themselves a significant behavioural finding — they
  // should never appear as a tail clause that contradicts a "no patterns"
  // header.
  if (s.tiltEpisodes && s.tiltEpisodes.count > 0) {
    const n = s.tiltEpisodes.count;
    flags.push(`${n} tilt episode${n === 1 ? '' : 's'}`);
  }

  if (flags.length === 0) {
    return 'No significant behavioural patterns or tilt episodes surfaced this period.';
  }
  if (flags.length === 1) {
    return `One behavioural finding stands out: ${flags[0]}.`;
  }
  const last = flags.pop();
  return `Multiple behavioural findings are present — ${flags.join(', ')}, and ${last}.`;
}

// ─── Per-detector accessors (defensive — return null on shape mismatch) ───

function deriveSerialDependence(insight?: Insight): BehavioralSection['serialDependence'] {
  if (!insight) return null;
  const d = insight.data ?? {};
  const lossAfterLoss = numberOr(d.lossAfterLossRate, d.lossAfterLoss);
  const winAfterWin = numberOr(d.winAfterWinRate, d.winAfterWin);
  const lossAfterWin = numberOr(d.lossAfterWinRate, d.lossAfterWin);
  const winAfterLoss = numberOr(d.winAfterLossRate, d.winAfterLoss);
  if (
    lossAfterLoss == null && winAfterWin == null &&
    lossAfterWin == null && winAfterLoss == null
  ) {
    return null;
  }
  return {
    lossAfterLoss: lossAfterLoss ?? 0,
    winAfterWin: winAfterWin ?? 0,
    lossAfterWin: lossAfterWin ?? 0,
    winAfterLoss: winAfterLoss ?? 0,
    isSignificant: insight.isSignificant,
    pValue: firstPValue(insight.statistics),
  };
}

function deriveRevenge(insight?: Insight): BehavioralSection['revengeTradingSignals'] {
  if (!insight) return { detected: false, sizeAfterLoss: null, pnlAfterLoss: null };
  const d = insight.data ?? {};
  const sizePValue = pValueByName(insight.statistics, /size/i);
  const pnlPValue = pValueByName(insight.statistics, /pnl/i) ?? firstPValue(insight.statistics);
  return {
    detected: insight.isSignificant,
    sizeAfterLoss:
      typeof d.sizeChangePct === 'string' && sizePValue != null
        ? { change: d.sizeChangePct, pValue: sizePValue }
        : typeof d.sizeChangePct === 'number' && sizePValue != null
          ? { change: `${d.sizeChangePct > 0 ? '+' : ''}${d.sizeChangePct.toFixed(1)}%`, pValue: sizePValue }
          : null,
    pnlAfterLoss:
      typeof d.avgPnlAfterLoss === 'number' && pnlPValue != null
        ? { avgPnl: round(d.avgPnlAfterLoss as number, 2), pValue: pnlPValue }
        : null,
  };
}

function deriveDisposition(insight?: Insight): BehavioralSection['dispositionEffect'] {
  if (!insight) return null;
  const d = insight.data ?? {};
  const winnerHoldTime = numberOr(d.winnerHoldTime, d.avgWinnerHoldTime);
  const loserHoldTime = numberOr(d.loserHoldTime, d.avgLoserHoldTime);
  const ratio = numberOr(d.ratio, d.dispositionRatio);
  if (winnerHoldTime == null || loserHoldTime == null) return null;
  return {
    detected: insight.isSignificant,
    winnerHoldTime,
    loserHoldTime,
    ratio: ratio ?? (loserHoldTime > 0 ? winnerHoldTime / loserHoldTime : 0),
    pValue: firstPValue(insight.statistics),
  };
}

function deriveTilt(data: ReportData): BehavioralSection['tiltEpisodes'] {
  const eps = data.tiltEpisodes ?? [];
  if (eps.length === 0) return null;

  // pnlDuringEpisode is the realised P&L over the episode's positions; sum
  // negative outcomes as the "cost" of tilt — positive episodes don't add.
  let totalCost = 0;
  let totalDurationSec = 0;
  let withDuration = 0;
  const triggers = new Map<string, number>();

  for (const e of eps) {
    if (e.pnlDuringEpisode < 0) totalCost += e.pnlDuringEpisode;
    if (e.endTime && e.startTime) {
      totalDurationSec += (e.endTime.getTime() - e.startTime.getTime()) / 1000;
      withDuration++;
    }
    triggers.set(e.trigger, (triggers.get(e.trigger) ?? 0) + 1);
  }

  let mostCommonTrigger = 'unknown';
  let bestCount = 0;
  for (const [t, c] of triggers) {
    if (c > bestCount) {
      bestCount = c;
      mostCommonTrigger = t;
    }
  }

  return {
    count: eps.length,
    totalCost: round(totalCost, 2),
    mostCommonTrigger,
    avgDuration: withDuration > 0 ? Math.round(totalDurationSec / withDuration) : 0,
  };
}

function deriveSessionFatigue(insight?: Insight): BehavioralSection['sessionFatigue'] {
  if (!insight) return null;
  const d = insight.data ?? {};
  const optimalTradeCount = numberOr(d.optimalTradeCount, d.optimalCount);
  const estimatedSavings = numberOr(d.estimatedSavings, d.dollarImpact);
  return {
    isSignificant: insight.isSignificant,
    optimalTradeCount,
    estimatedSavings,
  };
}

function deriveOvertrading(insight?: Insight): BehavioralSection['overtrading'] {
  if (!insight) return null;
  const d = insight.data ?? {};
  const correlationR = numberOr(d.correlationR, d.r) ?? 0;
  const heavyDayAvgPnl = numberOr(d.heavyDayAvgPnl, d.avgHeavyPnl) ?? 0;
  const lightDayAvgPnl = numberOr(d.lightDayAvgPnl, d.avgLightPnl) ?? 0;
  return {
    correlationR: round(correlationR, 4),
    isSignificant: insight.isSignificant,
    heavyDayAvgPnl: round(heavyDayAvgPnl, 2),
    lightDayAvgPnl: round(lightDayAvgPnl, 2),
  };
}

// ─── Generic insight summary ──────────────────────────────────────────────

function insightSummary(insight: Insight) {
  const t: StatisticalTest | undefined = insight.statistics?.[0];
  return {
    name: MODULE_LABELS[insight.module] ?? insight.module,
    finding: insight.title,
    isSignificant: insight.isSignificant,
    pValue: t ? t.pValue : null,
    effectSize: t ? t.effectSize : null,
    sampleSize: insight.sampleSize,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function numberOr(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && isFinite(c)) return c;
  }
  return null;
}

function firstPValue(tests?: StatisticalTest[]): number | null {
  if (!tests || tests.length === 0) return null;
  return typeof tests[0].pValue === 'number' ? tests[0].pValue : null;
}

function pValueByName(
  tests: StatisticalTest[] | undefined,
  pattern: RegExp,
): number | null {
  if (!tests) return null;
  const t = tests.find((x) => pattern.test(x.testName) || pattern.test(x.description ?? ''));
  return t ? t.pValue : null;
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
