'use client';

import type { RuleResult } from '@/services/playbooks/types';

/**
 * Renders a playbook adherence result block — score header + per-rule list
 * with ✓ / ✗ / ─ icons. Used both in the annotation popup (preview after
 * picking a playbook) and the trade detail modal (stored result).
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
  const { outcome, ruleLabel, actual, expected } = result;
  const icon =
    outcome === 'passed' ? <span className="text-green-400">✓</span> :
    outcome === 'failed' ? <span className="text-red-400">✗</span> :
    <span className="text-[#6e7681]">─</span>;

  const labelColor =
    outcome === 'passed' ? 'text-[#e6edf3]' :
    outcome === 'failed' ? 'text-[#e6edf3]' :
    'text-[#8b949e]';

  const detail = outcome === 'inconclusive'
    ? actual
    : `${actual} (${outcome === 'passed' ? 'met' : 'limit'} ${expected})`;

  return (
    <div className="flex items-start gap-2 text-xs py-0.5">
      <span className="shrink-0 w-3 text-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={labelColor}>{ruleLabel}</div>
        <div className="text-[10px] text-[#6e7681] truncate" title={detail}>{detail}</div>
      </div>
    </div>
  );
}
