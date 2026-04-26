/**
 * Trading-report data types.
 *
 * The orchestrator returns a TradingReport — a frozen snapshot of every
 * section the report can show. Each section is independently nullable so
 * partial reports are possible when slow-tier metrics, Monte Carlo, or
 * stored insights aren't available yet (the section returns null instead
 * of throwing).
 */

// ─── Top-level ─────────────────────────────────────────────────────────────

export interface TradingReport {
  generatedAt: string;
  walletAddress: string;
  /** First entry through last exit across the included positions. */
  period: { from: string; to: string };
  tradeCount: number;
  /**
   * Human-readable description of the filters in effect, e.g.
   * "Manual only · BTC". Empty string means "No filters — full trading
   * history". Surfaced in the cover page so a reader knows what they're
   * looking at.
   */
  filtersDescription: string;
  sections: {
    executiveSummary: ExecutiveSummarySection | null;
    performance: PerformanceSection | null;
    behavioral: BehavioralSection | null;
    risk: RiskSection | null;
    execution: ExecutionSection | null;
    regime: RegimeSection | null;
    methodology: MethodologySection;
  };
}

// ─── Section: Executive summary ────────────────────────────────────────────

export interface ExecutiveSummarySection {
  /** WART; surfaced as "Composite Trader Score" in user-facing copy. */
  compositeScore: {
    score: number;
    tier: string;
    axes: Record<string, number>;
  };
  eloRating: {
    current: number;
    tier: string;
    trend: string;
  } | null;
  headlineMetrics: {
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    winRate: number;
    expectancy: number;
    profitFactor: number;
  };
  topStrengths: string[];
  topWeaknesses: string[];
  recommendations: string[];
}

// ─── Section: Performance ──────────────────────────────────────────────────

export interface BreakdownRow {
  label: string;
  winRate: number;
  expectancy: number;
  tradeCount: number;
  totalPnl: number;
  isSignificant: boolean;
  pValue: number | null;
}

export interface PerformanceSection {
  /** 1-2 sentence italic intro, generated dynamically from the numbers below. */
  summary: string;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  bestTrade: { asset: string; pnl: number; date: string } | null;
  worstTrade: { asset: string; pnl: number; date: string } | null;
  regimeBreakdown: BreakdownRow[];
  tradeTypeBreakdown: BreakdownRow[];
}

// ─── Section: Behavioral ───────────────────────────────────────────────────

export interface BehavioralSection {
  summary: string;
  serialDependence: {
    lossAfterLoss: number;
    winAfterWin: number;
    lossAfterWin: number;
    winAfterLoss: number;
    isSignificant: boolean;
    pValue: number | null;
  } | null;
  revengeTradingSignals: {
    detected: boolean;
    sizeAfterLoss: { change: string; pValue: number } | null;
    pnlAfterLoss: { avgPnl: number; pValue: number } | null;
  };
  dispositionEffect: {
    detected: boolean;
    winnerHoldTime: number;
    loserHoldTime: number;
    ratio: number;
    pValue: number | null;
  } | null;
  tiltEpisodes: {
    count: number;
    totalCost: number;
    mostCommonTrigger: string;
    avgDuration: number;
  } | null;
  sessionFatigue: {
    isSignificant: boolean;
    optimalTradeCount: number | null;
    estimatedSavings: number | null;
  } | null;
  overtrading: {
    correlationR: number;
    isSignificant: boolean;
    heavyDayAvgPnl: number;
    lightDayAvgPnl: number;
  } | null;
  insights: Array<{
    name: string;
    finding: string;
    isSignificant: boolean;
    pValue: number | null;
    effectSize: number | null;
    sampleSize: number;
  }>;
  /** Cross-signal behavioural-syndrome diagnoses. Null when the syndrome
   *  pass couldn't run (e.g. no stored insights). */
  syndromes: {
    results: Array<{
      name: string;
      displayName: string;
      confidence: 'strong' | 'moderate' | 'weak' | 'absent';
      presentCount: number;
      totalCount: number;
      summary: string;
      intervention: string | null;
      requiredSignals: Array<{
        name: string;
        displayName: string;
        status: 'present' | 'absent' | 'insufficient_data';
        description: string;
        pValue: number | null;
      }>;
      supportingSignals: Array<{
        name: string;
        displayName: string;
        status: 'present' | 'absent' | 'insufficient_data';
        description: string;
        pValue: number | null;
      }>;
      contradictingSignals: Array<{
        name: string;
        displayName: string;
        status: 'present' | 'absent' | 'insufficient_data';
        description: string;
        pValue: number | null;
      }>;
    }>;
    dominantSyndrome: string | null;
    overallAssessment: string;
  } | null;
}

// ─── Section: Risk ─────────────────────────────────────────────────────────

export interface RiskSection {
  summary: string;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  maxDrawdownDollars: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  monteCarlo: {
    probDrawdown25: number;
    probDrawdown50: number;
    probRuin: number;
    medianFinalBalance: number;
    p10FinalBalance: number;
    p90FinalBalance: number;
  } | null;
  recoveryFactor: number | null;
}

// ─── Section: Execution ────────────────────────────────────────────────────

export interface ExecutionSection {
  summary: string;
  avgExitEfficiency: number | null;
  exitEfficiencyByRegime:
    | Array<{ regime: string; efficiency: number; tradeCount: number }>
    | null;
  avgMae: number | null;
  avgMfe: number | null;
  /**
   * MAE / MFE — closer to 0 means entries print very little adverse excursion
   * relative to the favourable side. Lower is better.
   */
  entryTimingScore: number | null;
}

// ─── Section: Regime ───────────────────────────────────────────────────────

export interface RegimeSection {
  summary: string;
  currentRegime: string | null;
  performanceByRegime: BreakdownRow[];
  edgePersistence: {
    trend: string;
    firstAvg: number;
    lastAvg: number;
    summary: string;
  } | null;
  recommendations: string[];
}

// ─── Section: Methodology ──────────────────────────────────────────────────

export interface MethodologyEntry {
  test: string;
  hypothesis: string;
  method: string;
  sampleA: number;
  sampleB: number;
  result: string;
  finding: string;
}

export interface MethodologySection {
  correctionMethod: string;
  dataSources: string[];
  knownLimitations: string[];
  entries: MethodologyEntry[];
}
