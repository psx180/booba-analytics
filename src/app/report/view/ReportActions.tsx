'use client';

import { useRouter } from 'next/navigation';

interface Props {
  wallet: string;
  reportJson: string;
}

export default function ReportActions({ wallet, reportJson }: Props) {
  const router = useRouter();

  const printReport = () => {
    if (typeof window !== 'undefined') window.print();
  };

  const downloadJson = () => {
    const blob = new Blob([reportJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-report-${wallet.slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const viewFullApp = () => {
    document.cookie = `manual-wallet=${wallet}; path=/; max-age=86400`;
    router.replace('/dashboard');
  };

  const generateAnother = () => {
    router.replace('/connect');
  };

  return (
    <header className="no-print sticky top-0 z-50 bg-[#0d1117]/95 backdrop-blur border-b border-[#30363d]">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm font-semibold text-white tracking-wide">
          BOOBAnalytics Trading Report
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={printReport}
            className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
          >
            Print Report
          </button>
          <button
            onClick={downloadJson}
            className="px-3 py-1.5 rounded-md border border-[#30363d] hover:border-[#58a6ff] text-[#c9d1d9] text-xs transition-colors"
          >
            Download JSON
          </button>
          <button
            onClick={viewFullApp}
            className="px-3 py-1.5 rounded-md border border-[#30363d] hover:border-[#58a6ff] text-[#c9d1d9] text-xs transition-colors"
          >
            View Full App
          </button>
          <button
            onClick={generateAnother}
            className="px-3 py-1.5 rounded-md text-[#8b949e] hover:text-[#c9d1d9] text-xs transition-colors"
          >
            Generate Another
          </button>
        </div>
      </div>
    </header>
  );
}
