'use client';

/**
 * /report?wallet=ADDRESS — public report-generation page.
 *
 * Reads the wallet from the query string, kicks off the public
 * /api/report/generate pipeline, and renders a 6-step progress tracker.
 * Auto-downloads the PDF when ready.
 *
 * No auth required. No wallet connection needed.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type StepStatus = 'pending' | 'active' | 'complete' | 'error';

interface StepView {
  index: number;
  title: string;
  detail: string;
  status: StepStatus;
}

interface StatusResponse {
  jobId: string;
  state: 'queued' | 'running' | 'complete' | 'error';
  cached: boolean;
  error?: string;
  progress: null | {
    stage: 'fetching' | 'fetching_orders' | 'syncing' | 'grouping' | 'enriching' | 'regimes' | 'computing' | 'rendering' | 'done' | 'error';
    message: string;
    fillsFetched: number;
    computingTier?: 'fast' | 'slow';
    balanceEvents?: number;
    equitySnapshots?: number;
    positionsCreated?: number;
  };
}

// Progress stages in pipeline order. Used to figure out which UI steps are
// already "behind" the current stage (=> complete).
const STAGE_ORDER: Record<string, number> = {
  fetching: 1,
  fetching_orders: 1,
  syncing: 2,
  grouping: 3,
  enriching: 3,
  'computing-fast': 4,
  'computing-slow': 5,
  rendering: 6,
  done: 7,
};

function stageRank(progress: StatusResponse['progress']): number {
  if (!progress) return 0;
  if (progress.stage === 'computing') {
    return progress.computingTier === 'slow' ? STAGE_ORDER['computing-slow'] : STAGE_ORDER['computing-fast'];
  }
  return STAGE_ORDER[progress.stage] ?? 0;
}

export default function ReportPage() {
  return (
    <Suspense fallback={<ReportLayout><div className="text-[#8b949e] text-sm">Loading…</div></ReportLayout>}>
      <ReportPageInner />
    </Suspense>
  );
}

function ReportPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const wallet = (params.get('wallet') ?? '').trim();

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'complete' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const downloadedRef = useRef(false);

  // Validate wallet & redirect to /connect if missing/invalid.
  useEffect(() => {
    if (!wallet || !/^[A-Za-z0-9]{32,88}$/.test(wallet)) {
      router.replace('/connect');
    }
  }, [wallet, router]);

  // Kick off the job once on mount.
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/report/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: wallet }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Failed to start report (${res.status})`);
        }
        if (cancelled) return;
        setPhase('running');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to start report');
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, [wallet]);

  // Poll status every 2 seconds while running.
  useEffect(() => {
    if (!wallet || phase !== 'running') return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/report/generate/status?jobId=${encodeURIComponent(wallet)}`);
        if (!res.ok) return;
        const body: StatusResponse = await res.json();
        if (cancelled) return;
        setStatus(body);
        if (body.state === 'complete') {
          setPhase('complete');
        } else if (body.state === 'error') {
          setError(body.error ?? body.progress?.message ?? 'Report generation failed');
          setPhase('error');
        }
      } catch {
        // Transient — keep polling.
      }
    };

    void tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wallet, phase]);

  // Auto-download when complete.
  const triggerDownload = useCallback(() => {
    if (!wallet) return;
    const url = `/api/report/generate/download?jobId=${encodeURIComponent(wallet)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-report-${wallet.slice(0, 8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [wallet]);

  useEffect(() => {
    if (phase === 'complete' && !downloadedRef.current) {
      downloadedRef.current = true;
      triggerDownload();
    }
  }, [phase, triggerDownload]);

  const exploreFullApp = () => {
    document.cookie = `manual-wallet=${wallet}; path=/; max-age=86400`;
    router.replace('/dashboard');
  };

  const generateAnother = () => {
    router.replace('/connect');
  };

  const steps = buildSteps(status, phase);

  return (
    <ReportLayout>
      <h1 className="text-3xl font-bold text-white tracking-wider mb-2">Generating Report</h1>
      <p className="text-sm text-[#8b949e] mb-1">
        For wallet <span className="font-mono text-[#c9d1d9]">{shorten(wallet)}</span>
      </p>
      {status?.cached && phase !== 'complete' && phase !== 'error' && (
        <p className="text-xs text-[#58a6ff] mb-6">
          This wallet was analyzed recently — skipping import.
        </p>
      )}
      {!status?.cached && (
        <p className="text-xs text-[#6e7681] mb-6">
          New wallets take a few minutes. Keep this tab open.
        </p>
      )}

      <div className="w-full max-w-md flex flex-col gap-3">
        {steps.map((step) => (
          <StepRow key={step.index} step={step} />
        ))}
      </div>

      {phase === 'complete' && (
        <div className="mt-10 w-full max-w-md flex flex-col items-center gap-4">
          <div className="text-center">
            <p className="text-green-400 text-sm font-medium mb-1">Report ready</p>
            <p className="text-xs text-[#6e7681]">Your PDF should download automatically.</p>
          </div>
          <div className="flex flex-col gap-2 w-full">
            <button
              onClick={triggerDownload}
              className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors"
            >
              Download Report
            </button>
            <button
              onClick={exploreFullApp}
              className="px-6 py-3 rounded-lg border border-[#30363d] hover:border-[#58a6ff] text-[#c9d1d9] text-sm transition-colors"
            >
              View Full App
            </button>
            <button
              onClick={generateAnother}
              className="px-6 py-3 rounded-lg border border-transparent hover:border-[#30363d] text-[#8b949e] text-xs transition-colors"
            >
              Generate Another Report
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-10 w-full max-w-md flex flex-col items-center gap-4">
          <div className="text-center">
            <p className="text-red-400 text-sm font-medium mb-1">Something went wrong</p>
            <p className="text-xs text-[#6e7681] break-words">{error ?? 'Unknown error'}</p>
          </div>
          <button
            onClick={() => {
              setError(null);
              setStatus(null);
              setPhase('starting');
              downloadedRef.current = false;
              // Re-run the kickoff effect by changing key; easiest: full reload.
              window.location.reload();
            }}
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors"
          >
            Retry
          </button>
          <button
            onClick={generateAnother}
            className="px-6 py-3 rounded-lg border border-[#30363d] hover:border-[#58a6ff] text-[#c9d1d9] text-sm transition-colors"
          >
            Back to Connect
          </button>
        </div>
      )}
    </ReportLayout>
  );
}

function buildSteps(status: StatusResponse | null, phase: 'starting' | 'running' | 'complete' | 'error'): StepView[] {
  const progress = status?.progress ?? null;
  const cached = status?.cached === true;
  const rank = stageRank(progress);

  const detail = (i: number): string => {
    switch (i) {
      case 1:
        return progress?.fillsFetched ? `${progress.fillsFetched.toLocaleString()} fills loaded` : 'Pulling trade history';
      case 2: {
        const be = progress?.balanceEvents;
        const es = progress?.equitySnapshots;
        if (be != null && es != null) return `${be} balance events, ${es.toLocaleString()} equity snapshots`;
        return 'Balance events + equity snapshots';
      }
      case 3:
        return progress?.positionsCreated != null
          ? `${progress.positionsCreated.toLocaleString()} positions created`
          : 'Building positions from fills';
      case 4: return 'xPnL, insights, tilt detection';
      case 5: return 'Regime detection, exit quality, risk metrics';
      case 6: return 'Rendering PDF';
      default: return '';
    }
  };

  const titles = [
    'Fetching trade history from Pacifica',
    'Syncing account history',
    'Grouping fills into positions',
    'Computing fast analytics',
    'Computing deep analytics',
    'Generating report',
  ];

  return titles.map((title, idx) => {
    const i = idx + 1;
    let st: StepStatus;

    if (phase === 'complete') {
      st = 'complete';
    } else if (cached && i <= 5) {
      // Cached path: import is skipped, only step 6 runs.
      st = 'complete';
    } else if (phase === 'error') {
      // Mark the current step as error, earlier steps as complete, later as pending.
      if (i < rank) st = 'complete';
      else if (i === Math.max(rank, 1)) st = 'error';
      else st = 'pending';
    } else if (rank === 0) {
      // Job started but no progress entry yet — first step is active.
      st = i === 1 ? 'active' : 'pending';
    } else if (i < rank) {
      st = 'complete';
    } else if (i === rank) {
      st = 'active';
    } else {
      st = 'pending';
    }

    return { index: i, title, detail: detail(i), status: st };
  });
}

function StepRow({ step }: { step: StepView }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <StepIcon status={step.status} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${
          step.status === 'complete' ? 'text-[#c9d1d9]' :
          step.status === 'active'   ? 'text-white font-medium' :
          step.status === 'error'    ? 'text-red-400' :
                                       'text-[#6e7681]'
        }`}>
          {step.title}
        </div>
        <div className={`text-xs mt-0.5 ${step.status === 'pending' ? 'text-[#484f58]' : 'text-[#8b949e]'}`}>
          {step.detail}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'complete') {
    return (
      <div className="w-5 h-5 mt-0.5 rounded-full bg-green-600/20 border border-green-500 flex items-center justify-center">
        <svg className="w-3 h-3 text-green-400" viewBox="0 0 16 16" fill="none">
          <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (status === 'active') {
    return (
      <div className="w-5 h-5 mt-0.5 rounded-full border-2 border-[#30363d] border-t-blue-400 animate-spin" />
    );
  }
  if (status === 'error') {
    return (
      <div className="w-5 h-5 mt-0.5 rounded-full bg-red-600/20 border border-red-500 flex items-center justify-center">
        <svg className="w-3 h-3 text-red-400" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  // pending
  return (
    <div className="w-5 h-5 mt-0.5 rounded-full border border-[#30363d]" />
  );
}

function ReportLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12">
      <div className="flex flex-col items-center max-w-md w-full text-center">
        {children}
      </div>
    </div>
  );
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}
