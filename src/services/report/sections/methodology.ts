import type { Insight, StatisticalTest } from '../../analytics/types';
import type { ReportData } from '../data';
import type { MethodologyEntry, MethodologySection } from '../types';

const KNOWN_LIMITATIONS = [
  'Sharpe uses per-trade returns, not daily mark-to-market',
  'Regime detection uses BTC as market proxy',
  'xPnL uses walk-forward KNN (no future data leakage)',
  'Monte Carlo assumes iid returns (no autocorrelation or regime switching)',
];

const DATA_SOURCES = [
  'Pacifica REST API (trade history, funding, balance events)',
  'Pacifica candle data (MFE/MAE, regime detection)',
];

const HYPOTHESES: Record<string, string> = {
  'revenge-trading': 'Position size or P&L after a loss differs from baseline',
  'disposition': 'Winners are exited faster than losers',
  'streak-behavior': 'Behaviour during win/loss streaks differs from baseline',
  'overtrading': 'Per-trade P&L correlates negatively with daily trade count',
  'session-fatigue': 'Performance degrades within a single session as trades accumulate',
  'tilt-episodes': 'Position behaviour during tilt periods differs from baseline',
  'time-of-day-edge': 'Performance varies systematically by time-of-day bucket',
  'exit-optimizer': 'Exit timing is suboptimal relative to MFE',
  'hold-time-optimizer': 'Hold-time bucket affects expectancy',
  'outlier-dependency': 'Aggregate P&L depends disproportionately on a few trades',
  'combinatorial-search': 'At least one slice of trades has a real edge or leak',
  'wart-insight': 'Composite trader score axes diverge from baseline',
  'xpnl-insight': 'Realized P&L diverges from KNN-baseline expectation',
  'entropy-insight': 'Trade-type distribution is more or less concentrated than baseline',
  'liquidation': 'Liquidation cause materially affects expectancy',
  'regime-mismatch': 'Performance varies across BTC market regimes',
  'sizing-analysis': 'Position size correlates with subsequent outcomes',
  'size-escalation': 'Size growth across consecutive trades affects outcomes',
  'social-correlation': 'Social-sentiment exposure correlates with P&L',
  'ml-patterns-clustering': 'Latent clusters of trades have different expectancy',
};

export function generateMethodology(data: ReportData): MethodologySection {
  const entries: MethodologyEntry[] = [];
  for (const insight of data.storedInsights) {
    for (const test of insight.statistics ?? []) {
      const e = entryFor(insight, test);
      if (e) entries.push(e);
    }
  }
  // Most-significant findings first so the appendix opens with what matters.
  entries.sort((a, b) => parseP(a.result) - parseP(b.result));

  return {
    correctionMethod:
      'Benjamini-Hochberg FDR correction at q=0.10 across all insight detectors. ' +
      'Per-detector internal corrections may also apply (see each test\'s correctionApplied).',
    dataSources: DATA_SOURCES,
    knownLimitations: KNOWN_LIMITATIONS,
    entries,
  };
}

function entryFor(insight: Insight, test: StatisticalTest): MethodologyEntry | null {
  const method = describeMethod(test);
  if (!method) return null;
  return {
    test: prettyName(insight.module),
    hypothesis: HYPOTHESES[insight.module] ?? insight.title,
    method,
    sampleA: test.sampleSizeA,
    sampleB: test.sampleSizeB,
    result: describeResult(test),
    finding: test.isSignificant ? 'Significant' : 'Not significant',
  };
}

function describeMethod(test: StatisticalTest): string {
  const correction = test.correctionApplied
    ? ` (correction: ${test.correctionApplied})`
    : '';
  switch (test.testName) {
    case 'welch_t_test':         return `Welch's t-test${correction}`;
    case 'chi_squared':           return `Chi-squared proportion test${correction}`;
    case 'fisher_exact':          return `Fisher's exact test${correction}`;
    case 'correlation':           return `Pearson correlation${correction}`;
    case 'descriptive':           return 'Descriptive (no hypothesis test)';
    default:                      return `${test.testName}${correction}`;
  }
}

function describeResult(test: StatisticalTest): string {
  const p = test.pValue < 0.001 ? 'p<0.001' : `p=${test.pValue.toFixed(3)}`;
  const effect = `effect=${test.effectSize.toFixed(2)}`;
  return `${p}, ${effect}, N=${test.sampleSizeA}+${test.sampleSizeB}`;
}

function parseP(result: string): number {
  const m = /p[=<]([0-9.]+)/.exec(result);
  return m ? parseFloat(m[1]) : 1;
}

function prettyName(module: string): string {
  return module
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
