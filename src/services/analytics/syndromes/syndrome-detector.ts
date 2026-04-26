/**
 * Syndrome detector — pure synthesis over already-tested signals.
 *
 * The detector itself runs no statistical tests. It reads stored insight
 * outputs (which have been corrected by the global Benjamini-Hochberg pass
 * inside analytics-service.ts) plus a couple of non-insight artefacts
 * (walk-forward, regime breakdown), and applies a fixed presence/absence
 * rubric to determine each syndrome's confidence and intervention.
 */

import { prisma } from '../../../lib/prisma';
import { createAnalyticsService } from '..';
import { computeWalkForward } from '../walk-forward';
import { breakdownAggregator } from '../aggregations/breakdown';
import { SYNDROMES } from './definitions';
import type {
  SyndromeDef,
  SyndromeInputData,
  SyndromeReport,
  SyndromeResult,
  SyndromeSignal,
} from './types';

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Pure synthesis over already-loaded data. Use this from the report flow
 * where everything has already been fetched.
 */
export function evaluateSyndromes(input: SyndromeInputData): SyndromeReport {
  const syndromes = SYNDROMES.map((def) => evaluateSyndrome(def, input));
  const dominant = pickDominant(syndromes);
  return {
    syndromes,
    dominantSyndrome: dominant,
    overallAssessment: buildOverallAssessment(syndromes, dominant),
  };
}

/**
 * Convenience wrapper that loads everything from the database and then
 * calls evaluateSyndromes. Used by the API route and any standalone
 * caller.
 */
export async function detectSyndromes(
  walletAddress: string,
  journalId?: string,
): Promise<SyndromeReport> {
  const input = await loadSyndromeInputData(walletAddress, journalId);
  return evaluateSyndromes(input);
}

/**
 * Build the SyndromeInputData bag for a wallet. Defensive on every fetch —
 * any failure resolves to an empty/null source so the syndrome pass can
 * still run and emit insufficient_data signals where appropriate.
 */
export async function loadSyndromeInputData(
  walletAddress: string,
  journalId?: string,
): Promise<SyndromeInputData> {
  const service = createAnalyticsService();
  const [insightsRes, walkForward, positions] = await Promise.all([
    service.getStoredInsights(walletAddress, journalId).catch(() => ({ insights: [], lastComputedAt: null })),
    computeWalkForward(prisma, walletAddress, journalId).catch(() => null),
    service.loadPositions(walletAddress, journalId ? { journalId } : undefined).catch(() => []),
  ]);

  const regimeAgg = breakdownAggregator.aggregate(positions, { groupBy: 'regime' });
  const regimeBreakdown = (regimeAgg.breakdowns?.regime ?? {}) as Record<string, Record<string, any>>;

  return {
    insights: insightsRes.insights,
    walkForward,
    regimeBreakdown,
  };
}

// ─── Per-syndrome evaluation ──────────────────────────────────────────────

function evaluateSyndrome(def: SyndromeDef, data: SyndromeInputData): SyndromeResult {
  const requiredSignals    = def.required.map((s) => s.extract(data));
  const supportingSignals  = def.supporting.map((s) => s.extract(data));
  const contradictingSignals = def.contradicting.map((s) => s.extract(data));

  const requiredPresent     = requiredSignals.filter((s) => s.status === 'present').length;
  const requiredTotal       = requiredSignals.length;
  const supportingPresent   = supportingSignals.filter((s) => s.status === 'present').length;
  const contradictingPresent = contradictingSignals.filter((s) => s.status === 'present').length;

  const presentCount = requiredPresent + supportingPresent;
  const totalCount   = requiredTotal + supportingSignals.length;

  const confidence = resolveConfidence(
    requiredPresent,
    requiredTotal,
    supportingPresent,
    contradictingPresent,
  );

  const summary = buildSyndromeSummary(
    def, confidence, requiredSignals, supportingSignals, contradictingSignals,
  );

  const intervention = confidence === 'moderate' || confidence === 'strong'
    ? def.intervention(data)
    : null;

  return {
    name: def.name,
    displayName: def.displayName,
    confidence,
    requiredSignals,
    supportingSignals,
    contradictingSignals,
    presentCount,
    totalCount,
    summary,
    intervention,
  };
}

function resolveConfidence(
  requiredPresent: number,
  requiredTotal: number,
  supportingPresent: number,
  contradictingPresent: number,
): SyndromeResult['confidence'] {
  if (requiredPresent === 0) return 'absent';
  if (requiredPresent === requiredTotal && contradictingPresent === 0) return 'strong';
  // With any contradicting signal present the strongest we'll allow is 'weak'.
  if (contradictingPresent > 0) return 'weak';
  if (requiredPresent >= 1 && supportingPresent >= 1) return 'moderate';
  return 'weak';
}

// ─── Natural-language summaries ───────────────────────────────────────────

function buildSyndromeSummary(
  def: SyndromeDef,
  confidence: SyndromeResult['confidence'],
  required: SyndromeSignal[],
  supporting: SyndromeSignal[],
  contradicting: SyndromeSignal[],
): string {
  if (confidence === 'absent') {
    return `${def.displayName} not detected. None of the required signals are present.`;
  }
  const presentSignals = [...required, ...supporting].filter((s) => s.status === 'present');
  const presentDescriptions = presentSignals.map((s) => s.description);
  const evidenceCount = presentSignals.length;
  const totalSignals  = required.length + supporting.length;
  const evidence = presentDescriptions.length > 0
    ? `Indicators present: ${presentDescriptions.join('; ')}.`
    : 'No specific indicators present.';

  const contradictingPresent = contradicting.filter((s) => s.status === 'present');
  const contradictionLine = contradictingPresent.length > 0
    ? ` Contradicting: ${contradictingPresent.map((s) => s.description).join('; ')}.`
    : ' No contradicting evidence.';

  const opener = `${def.displayName} pattern detected (${confidence} confidence). ${evidenceCount} of ${totalSignals} indicators present.`;
  return `${opener} ${evidence}${contradictionLine}`;
}

// ─── Dominant syndrome + overall assessment ──────────────────────────────

const CONFIDENCE_RANK: Record<SyndromeResult['confidence'], number> = {
  strong: 3, moderate: 2, weak: 1, absent: 0,
};

function pickDominant(results: SyndromeResult[]): SyndromeResult | null {
  let best: SyndromeResult | null = null;
  for (const r of results) {
    if (CONFIDENCE_RANK[r.confidence] < CONFIDENCE_RANK['moderate']) continue;
    if (best == null || CONFIDENCE_RANK[r.confidence] > CONFIDENCE_RANK[best.confidence]) {
      best = r;
      continue;
    }
    if (
      CONFIDENCE_RANK[r.confidence] === CONFIDENCE_RANK[best.confidence] &&
      r.presentCount > best.presentCount
    ) {
      best = r;
    }
  }
  return best;
}

function buildOverallAssessment(
  results: SyndromeResult[],
  dominant: SyndromeResult | null,
): string {
  const detected = results.filter((r) => CONFIDENCE_RANK[r.confidence] >= CONFIDENCE_RANK['moderate']);
  if (detected.length === 0) {
    return 'No significant behavioural syndromes detected. Your trading behaviour is consistent across the conditions tested.';
  }

  const lead = dominant
    ? `Your primary behavioural challenge is ${dominant.displayName.toLowerCase()} (${dominant.confidence} confidence). ${dominant.summary}`
    : `${detected.length} behavioural syndrome${detected.length === 1 ? '' : 's'} detected.`;

  const others = detected.filter((r) => r !== dominant);
  if (others.length === 0) {
    const absentNames = results
      .filter((r) => r.confidence === 'absent')
      .map((r) => r.displayName.toLowerCase());
    if (absentNames.length === 0) return lead;
    return `${lead} No evidence of ${absentNames.join(', ')}.`;
  }

  const otherNames = others.map((r) => `${r.displayName.toLowerCase()} (${r.confidence})`);
  return `${lead} Also detected: ${otherNames.join(', ')}.`;
}
