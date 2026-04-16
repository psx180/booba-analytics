'use client';

import { useGroupingProgress } from '@/app/GroupingProgressContext';

/**
 * Floating top-right toast for long-running background jobs (currently: grouping
 * rebuild). Lives in AppShell so it persists across page navigation.
 *
 * - Shows live percent progress while the job runs.
 * - Close × hides the toast but does NOT cancel the job; polling in TradesClient
 *   stops updating once `dismissed` is true.
 * - Transitions to a success banner when done, then auto-dismisses (handled by
 *   the caller via setTimeout → setProgress(null)).
 */
export default function ProgressToast() {
  const { progress, dismissed, dismiss } = useGroupingProgress();

  if (!progress || dismissed) return null;

  const isError =
    progress.done &&
    (progress.msg.toLowerCase().includes('fail') || progress.msg.toLowerCase().includes('error'));

  return (
    <div className="fixed top-4 right-4 z-50 w-72 bg-[#1c2128] border border-[#30363d] rounded-lg shadow-xl p-3 space-y-2 pointer-events-auto">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`text-xs font-medium leading-snug ${
            progress.done
              ? isError
                ? 'text-red-400'
                : 'text-emerald-400'
              : 'text-[#e6edf3]'
          }`}
        >
          {progress.done
            ? isError
              ? progress.msg
              : `✓ ${progress.msg}`
            : `Rebuilding positions… ${progress.percent}%`}
        </span>
        <button
          onClick={dismiss}
          title="Dismiss"
          className="shrink-0 text-[#6e7681] hover:text-[#e6edf3] text-base leading-none mt-px transition-colors"
        >
          ×
        </button>
      </div>

      {!progress.done && (
        <div className="w-full bg-[#21262d] rounded-full h-1 overflow-hidden">
          <div
            className="bg-blue-500 h-1 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
