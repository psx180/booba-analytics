'use client';

/**
 * EdgeFinder — frontend for the combinatorial significance search.
 *
 * Renders the result of src/services/analytics/insights/combinatorial-search.ts
 * as two columns (edges / weaknesses) with a savings summary bar. The data
 * comes pre-attached to the corresponding insight (module 'combinatorial-search')
 * fetched once by AnalyticsClient — no separate API call.
 */

// ── Types (mirror server output) ──────────────────────────────────────────

interface StatisticalTest {
  testName: string;
  pValue: number;
  effectSize: number;
  isSignificant: boolean;
  correctionApplied?: string;
  description: string;
}

interface CombinatorialFinding {
  dimensions: { name: string; value: string }[];
  sliceLabel: string;
  positionCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  overallWinRate: number;
  overallAvgPnl: number;
  pnlTest: StatisticalTest;
  winRateTest: StatisticalTest;
  effectDirection: 'better' | 'worse';
}

export interface CombinatorialSearchResult {
  totalTestsRun: number;
  totalSurvivingBH: number;
  fdrRate: number;
  findings: CombinatorialFinding[];
  topEdges: CombinatorialFinding[];
  topWeaknesses: CombinatorialFinding[];
  estimatedSavings: number;
  computeMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtMoney(n: number, sign = false): string {
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (sign) return n >= 0 ? `+$${abs}` : `−$${abs}`;
  return `$${abs}`;
}

function fmtMoneyRound(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtPValue(p: number): string {
  if (p < 0.001) return 'p<0.001';
  return `p=${p.toFixed(3)}`;
}

function minP(f: CombinatorialFinding): number {
  return Math.min(f.pnlTest.pValue, f.winRateTest.pValue);
}

// ── Finding card ──────────────────────────────────────────────────────────

function FindingCard({
  finding,
  variant,
}: {
  finding: CombinatorialFinding;
  variant: 'edge' | 'weakness';
}) {
  const isEdge      = variant === 'edge';
  const accentText  = isEdge ? 'text-emerald-300' : 'text-red-300';
  const border      = isEdge ? 'border-emerald-500/30' : 'border-red-500/30';
  const winRatePct  = (finding.winRate * 100).toFixed(0);
  const baselinePct = (finding.overallWinRate * 100).toFixed(0);
  const wrDelta     = finding.winRate - finding.overallWinRate;
  const wrColor     =
    wrDelta > 0 ? 'text-emerald-400'
    : wrDelta < 0 ? 'text-red-400'
    : 'text-[#6e7681]';
  const avgDelta    = finding.avgPnl - finding.overallAvgPnl;
  const p           = minP(finding);
  const passedTests = [
    finding.pnlTest.isSignificant ? 'P&L' : null,
    finding.winRateTest.isSignificant ? 'Win Rate' : null,
  ].filter(Boolean) as string[];

  return (
    <div className={`bg-[#161b22] border ${border} rounded-lg p-3 flex flex-col gap-2`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-white">{finding.sliceLabel}</span>
        <span className="text-[10px] text-[#6e7681] shrink-0 mt-0.5">
          n={finding.positionCount}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="flex flex-col">
          <span className="text-[9px] uppercase tracking-widest text-[#6e7681]">Win Rate</span>
          <span className={`font-mono ${wrColor}`}>
            {winRatePct}%
            <span className="text-[10px] text-[#6e7681] ml-1">vs {baselinePct}%</span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] uppercase tracking-widest text-[#6e7681]">Avg P&L</span>
          <span className={`font-mono ${accentText}`}>{fmtMoney(finding.avgPnl)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] uppercase tracking-widest text-[#6e7681]">Total P&L</span>
          <span className={`font-mono ${accentText}`}>{fmtMoney(finding.totalPnl)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#21262d]">
        <span className="text-[10px] text-[#6e7681]">
          {fmtMoney(avgDelta, true)} per trade vs baseline
        </span>
        <div className="flex items-center gap-1.5">
          {passedTests.length > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/10 text-emerald-400">
              {passedTests.join(' + ')} ✓
            </span>
          )}
          <span className="text-[10px] font-mono text-[#8b949e]">{fmtPValue(p)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────

function EmptyColumn({ label }: { label: string }) {
  return (
    <div className="bg-[#0d1117] border border-dashed border-[#21262d] rounded-lg p-4 text-center">
      <p className="text-xs text-[#6e7681]">No statistically significant {label} detected.</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export default function EdgeFinder({ result }: { result: CombinatorialSearchResult | null }) {
  if (!result) {
    return (
      <div className="text-xs text-[#6e7681]">
        No edge-finder results yet — analytics run automatically after trades are imported.
        Requires at least 50 closed trades.
      </div>
    );
  }

  const { totalTestsRun, totalSurvivingBH, fdrRate, topEdges, topWeaknesses, estimatedSavings, computeMs } = result;

  if (totalSurvivingBH === 0) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-[#6e7681]">
          Tested <span className="text-white font-mono">{totalTestsRun}</span> dimension
          combinations at FDR=<span className="font-mono">{(fdrRate * 100).toFixed(0)}%</span>.
          No statistically significant patterns found after multiple-comparison correction.
          Your performance is consistent across all dimensions tested.
        </div>
        <div className="text-[10px] text-[#484f58]">Computed in {computeMs}ms.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-[#8b949e]">
        <span>
          <span className="text-white font-mono">{totalTestsRun}</span> tests run ·{' '}
          <span className="text-white font-mono">{totalSurvivingBH}</span> survived BH at q={(fdrRate * 100).toFixed(0)}%
        </span>
        <span className="text-[10px] text-[#484f58]">Computed in {computeMs}ms</span>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Your Edges
          </h3>
          {topEdges.length > 0 ? (
            topEdges.map((f, i) => (
              <FindingCard key={`edge-${i}`} finding={f} variant="edge" />
            ))
          ) : (
            <EmptyColumn label="edges" />
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-red-400">
            Your Weaknesses
          </h3>
          {topWeaknesses.length > 0 ? (
            topWeaknesses.map((f, i) => (
              <FindingCard key={`weakness-${i}`} finding={f} variant="weakness" />
            ))
          ) : (
            <EmptyColumn label="weaknesses" />
          )}
        </div>
      </div>

      {/* Savings summary bar */}
      {topWeaknesses.length > 0 && estimatedSavings > 0 && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-xs text-[#8b949e]">
            If you eliminated your top {topWeaknesses.length} weakness
            {topWeaknesses.length === 1 ? '' : 'es'}, estimated P&L improvement:
          </div>
          <div className="text-base font-mono font-semibold text-emerald-300">
            +${fmtMoneyRound(estimatedSavings)}
          </div>
        </div>
      )}
    </div>
  );
}
