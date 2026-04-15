'use client';

/**
 * OpenPositions — live unrealized P&L table for the dashboard.
 *
 * Rows come from the SSE `price_update` event (once mark prices arrive)
 * and fall back to the REST snapshot until the first tick lands. Clicking
 * a row jumps to the Trades page for deeper inspection.
 */

import Link from 'next/link';
import type { InitialLivePosition, LivePositionRow } from '@/hooks/usePacificaLive';

export interface OpenPositionsProps {
  openPositions: LivePositionRow[];
  initialPositions: InitialLivePosition[];
  connected: boolean;
}

interface DisplayRow {
  symbol: string;
  side: 'long' | 'short';
  amount: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
}

function mergeRows(
  live: LivePositionRow[],
  snapshot: InitialLivePosition[],
): DisplayRow[] {
  const byKey = new Map<string, DisplayRow>();
  for (const s of snapshot) {
    byKey.set(`${s.symbol}:${s.side}`, {
      symbol: s.symbol,
      side: s.side,
      amount: s.amount,
      entryPrice: s.entryPrice,
      currentPrice: null,
      unrealizedPnl: null,
      unrealizedPnlPct: null,
    });
  }
  for (const r of live) {
    byKey.set(`${r.symbol}:${r.side}`, { ...r });
  }
  return Array.from(byKey.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtPnl(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function pnlColor(v: number | null): string {
  if (v == null) return 'text-[#6e7681]';
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

export default function OpenPositions({
  openPositions,
  initialPositions,
  connected,
}: OpenPositionsProps) {
  const rows = mergeRows(openPositions, initialPositions);
  const totalUnrealized = rows.reduce(
    (s, r) => s + (r.unrealizedPnl ?? 0),
    0,
  );
  const hasLivePnl = rows.some((r) => r.unrealizedPnl != null);

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#21262d]">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Open Positions</h2>
          <span className="text-xs text-[#6e7681]">({rows.length})</span>
          {connected && (
            <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-widest text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
        </div>
        {hasLivePnl && (
          <div className="text-xs text-[#8b949e]">
            Total unrealized:{' '}
            <span className={pnlColor(totalUnrealized)}>{fmtPnl(totalUnrealized)}</span>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-[#6e7681]">
          No open positions.
        </div>
      ) : (
        <div className="divide-y divide-[#21262d]">
          {rows.map((r) => (
            <Link
              key={`${r.symbol}:${r.side}`}
              href="/trades"
              className="grid grid-cols-12 items-center gap-2 px-4 py-2 text-sm hover:bg-[#1c2128] transition-colors"
            >
              <span className="col-span-2 font-semibold text-white">{r.symbol}</span>
              <span
                className={`col-span-1 text-[10px] font-medium uppercase tracking-widest ${
                  r.side === 'long' ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {r.side}
              </span>
              <span className="col-span-2 text-[#8b949e] tabular-nums">{(r.amount ?? 0).toFixed(4)}</span>
              <span className="col-span-2 text-[#8b949e] tabular-nums">
                {fmtPrice(r.entryPrice)}
              </span>
              <span className="col-span-2 text-[#e6edf3] tabular-nums">
                {r.currentPrice != null ? fmtPrice(r.currentPrice) : '—'}
              </span>
              <span className={`col-span-2 text-right tabular-nums ${pnlColor(r.unrealizedPnl)}`}>
                {fmtPnl(r.unrealizedPnl)}
              </span>
              <span
                className={`col-span-1 text-right text-xs tabular-nums ${pnlColor(r.unrealizedPnlPct)}`}
              >
                {fmtPct(r.unrealizedPnlPct)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
