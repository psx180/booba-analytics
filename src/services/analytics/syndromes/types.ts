/**
 * Syndrome detection types.
 *
 * A syndrome is a named behavioural pattern (e.g. revenge trading) that
 * combines several already-tested signals from individual insight detectors
 * into a single diagnosis. The syndrome layer runs no statistical tests of
 * its own — it reads what the detectors have already produced and applies
 * a fixed presence/absence rubric to compute a confidence level and an
 * actionable intervention.
 */

import type { Insight } from '../types';
import type { WalkForwardResult } from '../walk-forward';

// ─── Public output types ──────────────────────────────────────────────────

export interface SyndromeSignal {
  /** Stable machine name, e.g. 'serial_dependence'. */
  name: string;
  /** Friendly label, e.g. 'Serial dependence'. */
  displayName: string;
  /** Whether this signal was detected in the data, or whether the underlying
   *  detector hasn't run / lacks data ('insufficient_data'). */
  status: 'present' | 'absent' | 'insufficient_data';
  /** From the underlying detector's primary statistical test, when present. */
  pValue: number | null;
  /** One-line summary of the evidence — used in the PDF checklist. */
  description: string;
}

export interface SyndromeResult {
  name: string;                        // 'revenge_trading'
  displayName: string;                 // 'Revenge Trading'
  confidence: 'strong' | 'moderate' | 'weak' | 'absent';
  requiredSignals: SyndromeSignal[];
  supportingSignals: SyndromeSignal[];
  contradictingSignals: SyndromeSignal[];
  presentCount: number;                // present required + supporting
  totalCount: number;                  // total required + supporting
  summary: string;                     // natural-language diagnosis
  intervention: string | null;         // recommendation if confidence >= moderate
}

export interface SyndromeReport {
  syndromes: SyndromeResult[];
  dominantSyndrome: SyndromeResult | null;
  overallAssessment: string;
}

// ─── Internal: data bundle handed to extractors ───────────────────────────

/**
 * Bag of pre-loaded analytics that signal extractors read from. Building
 * this bundle is the only I/O step in the syndrome flow — every extractor
 * is a pure function over this struct.
 *
 * `regimeBreakdown` is the breakdown aggregator's `breakdowns.regime` map:
 * keyed by regime name, values include winRate, expectancy, totalPnl, etc.
 */
export interface SyndromeInputData {
  insights: Insight[];
  walkForward: WalkForwardResult | null;
  regimeBreakdown: Record<string, Record<string, any>>;
}

// ─── Internal: definition objects ─────────────────────────────────────────

export interface SignalDef {
  name: string;
  displayName: string;
  /** Pure extractor — must always return a SyndromeSignal, never throw. */
  extract: (data: SyndromeInputData) => SyndromeSignal;
}

export interface SyndromeDef {
  name: string;
  displayName: string;
  required: SignalDef[];
  supporting: SignalDef[];
  contradicting: SignalDef[];
  /** Returns the recommendation text. A function so syndromes that quote
   *  specific numbers (e.g. "win rate drops to X%") can pull them at
   *  evaluation time. Constant interventions just return a literal. */
  intervention: (data: SyndromeInputData) => string;
}
