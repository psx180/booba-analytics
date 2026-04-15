'use client';

import type { RuleResult } from '@/services/playbooks/types';

/**
 * Renders a playbook adherence result block — score header + per-rule list.
 *
 * Icon convention (Part 5 — auto vs manual display pattern):
 *   📊 ✓  rule passed   — auto-verified
 *   📊 ✗  rule failed   — auto-verified
 *   ─     inconclusive  — needs manual review (data unavailable)
 *
 * Regime rules (Part 4) append "(BTC 1h based)" to the detail line so
 * the trader sees it's a BTC 1h proxy, not per-asset regime detection.
 */
export default function PlaybookAdherenceBreakdown({
  score,
  results,
  playbookName,
}: {
  score: number;
  results: RuleResult[];
  playbookName?: string;
}) {
  const passed = results.filter((r) => r.outcome === 'passed').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const denom = passed + failed;

  const scoreColor =
    denom === 0 ? 'text-[#6e7681]' :
    score >= 80 ? 'text-green-400' :
    score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">
          {playbookName ? `Playbook: ${playbookName}` : 'Adherence'}
        </div>
        <div className="text-xs text-[#8b949e]">
          <span className={`font-bold text-sm ${scoreColor}`}>{score.toFixed(0)}%</span>
          {denom > 0 && <span className="ml-2">({passed}/{denom} rules)</span>}
        </div>
      </div>

      {results.length === 0 ? (
        <div className="text-xs text-[#6e7681] italic">No enabled rules.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {results.map((r, i) => (
            <RuleRow key={i} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({ result }: { result: RuleResult }) {
  const { outcome, ruleType, ruleLabel, actual, expected } = result;

  // Part 5: 📊 for auto-checked (passed/failed), bare ─ for inconclusive
  const isAutoChecked = outcome === 'passed' || outcome === 'failed';
  const checkIcon =
    outcome === 'passed' ? <span className="text-green-400">✓</span> :
    outcome === 'failed' ? <span className="text-red-400">✗</span> :
    <span className="text-[#6e7681]">─</span>;

  const labelColor =
    outcome === 'inconclusive' ? 'text-[#8b949e]' : 'text-[#e6edf3]';

  // Part 4: regime rules get "(BTC 1h based)" appended to actual
  const isRegime = ruleType === 'regime';

  let detail: string;
  if (outcome === 'inconclusive') {
    detail = `${actual} — needs manual review`;
  } else {
    const actualDisplay = isRegime ? `${actual} (BTC 1h based)` : actual;
    const verb = outcome === 'passed' ? 'met' : 'limit';
    detail = `${actualDisplay} (${verb} ${expected})`;
  }

  return (
    <div className="flex items-start gap-1.5 text-xs py-0.5">
      {isAutoChecked && (
        <span className="shrink-0 text-[#6e7681] text-[10px] leading-4 mt-px">📊</span>
      )}
      <span className={`shrink-0 w-3 text-center ${!isAutoChecked ? 'ml-0' : ''}`}>
        {checkIcon}
      </span>
      <div className="min-w-0 flex-1">
        <div className={labelColor}>{ruleLabel}</div>
        <div className="text-[10px] text-[#6e7681] truncate" title={detail}>{detail}</div>
      </div>
    </div>
  );
}
