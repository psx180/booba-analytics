'use client';

/**
 * CarryOpportunities — compact carry trade scanner for the dashboard.
 *
 * Fetches /api/carry on mount. Gracefully hidden if the endpoint returns no
 * data (e.g. testnet-only endpoints not yet available on mainnet).
 *
 * Rows are expandable to show 24h/7d avg rates, volatility, LTV details,
 * and the full suggestion text.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import type { CarryOpportunity } from '@/services/pacifica/carry-service';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CarryResponse {
  opportunities: CarryOpportunity[];
  loanPoolAvailable: boolean;
  utilizationRate: number | null;
  borrowRateApr: number | null;
}

export interface CarryDataForBooba {
  topOpportunity: {
    symbol: string;
    stabilityScore: number;
    netApr: number | null;
    fundingAprGross: number;
    userHasMatchingShort: boolean;
  } | null;
  utilizationPct: number | null;
  payingFundingSymbols: string[];
}

interface CarryOpportunitiesProps {
  onDataLoaded?: (data: CarryDataForBooba) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRate(r: number): string {
  const pct = (r * 100).toFixed(4);
  return r >= 0 ? `+${pct}%` : `${pct}%`;
}

function fmtApr(apr: number): string {
  return `${apr >= 0 ? '+' : ''}${apr.toFixed(1)}%`;
}

function Stars({ score }: { score: number }) {
  return (
    <span className="text-amber-400 text-xs select-none" aria-label={`${score} stars`}>
      {'★'.repeat(score)}{'☆'.repeat(5 - score)}
    </span>
  );
}

function UtilizationBadge({ rate }: { rate: number | null }) {
  if (rate === null) return null;
  const pct = (rate * 100).toFixed(1);

  if (rate > 0.8) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 animate-pulse">
        Util: {pct}% ⚠
      </span>
    );
  }
  if (rate > 0.7) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-400">
        Util: {pct}%
      </span>
    );
  }
  if (rate > 0.5) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
        Util: {pct}%
      </span>
    );
  }
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">
      Util: {pct}% ✓
    </span>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function OpportunityRow({
  opp,
  loanPoolAvailable,
}: {
  opp: CarryOpportunity;
  loanPoolAvailable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const sign = opp.currentFundingRateHourly >= 0;

  return (
    <div className="border-b border-[#21262d] last:border-0">
      {/* ── Summary row ── */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-4 py-2.5 hover:bg-[#1c2128] transition-colors"
      >
        <div className="flex items-center gap-3 flex-wrap">
          {/* Symbol */}
          <span className="w-16 font-semibold text-white text-sm shrink-0">{opp.symbol}</span>

          {/* Hourly rate */}
          <span
            className={`text-xs tabular-nums font-medium w-20 shrink-0 ${sign ? 'text-green-400' : 'text-red-400'}`}
          >
            {fmtRate(opp.currentFundingRateHourly)}/hr
          </span>

          {/* Gross APR */}
          <span className="text-xs text-[#8b949e] shrink-0">
            Gross:{' '}
            <span className={sign ? 'text-green-400' : 'text-red-400'}>
              {fmtApr(opp.fundingAprGross)} APR
            </span>
          </span>

          {/* Net APR */}
          {loanPoolAvailable && opp.netApr !== null ? (
            <span className="text-xs text-[#8b949e] shrink-0">
              Net:{' '}
              <span className={opp.netApr >= 0 ? 'text-green-400' : 'text-red-400'}>
                {fmtApr(opp.netApr)} APR
              </span>
            </span>
          ) : (
            !loanPoolAvailable && (
              <span className="text-xs text-[#6e7681] shrink-0">Net: —</span>
            )
          )}

          {/* Stars */}
          <Stars score={opp.stabilityScore} />

          {/* Expand indicator */}
          <span className="ml-auto text-[#6e7681] text-xs">{expanded ? '▲' : '▼'}</span>
        </div>

        {/* LTV + suggestion preview */}
        <div className="mt-0.5 flex items-start gap-2 text-xs text-[#6e7681]">
          {opp.collateralEnabled && opp.ltvRatio !== null ? (
            <span className="shrink-0">LTV: {(opp.ltvRatio * 100).toFixed(0)}%</span>
          ) : (
            <span className="shrink-0">LTV: N/A</span>
          )}
          <span className="line-clamp-1">{opp.suggestion}</span>
        </div>
      </button>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="px-4 pb-3 pt-1 bg-[#0d1117] border-t border-[#21262d] text-xs space-y-1.5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[#8b949e]">
            <span>
              24h avg rate:{' '}
              <span className="text-[#e6edf3]">{fmtRate(opp.avgFundingRate24h)}/hr</span>
            </span>
            <span>
              7d avg rate:{' '}
              <span className="text-[#e6edf3]">{fmtRate(opp.avgFundingRate7d)}/hr</span>
            </span>
            <span>
              24h std dev:{' '}
              <span className="text-[#e6edf3]">
                {(opp.fundingRateStdDev24h * 100).toFixed(5)}%
              </span>
            </span>
            <span>
              Stability:{' '}
              <span className="text-[#e6edf3]">{opp.stabilityScore}/5</span>
            </span>
            {opp.ltvRatio !== null && (
              <span>
                LTV ratio:{' '}
                <span className="text-[#e6edf3]">{(opp.ltvRatio * 100).toFixed(0)}%</span>
              </span>
            )}
            {opp.collateralEnabled && (
              <span>
                Collateral:{' '}
                <span className="text-green-400">eligible</span>
              </span>
            )}
          </div>
          <p className="text-[#8b949e] leading-relaxed pt-0.5">{opp.suggestion}</p>
          {opp.utilizationWarning && (
            <p className="text-orange-400">
              High utilization — borrow rate may increase sharply.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function CarryOpportunities({ onDataLoaded }: CarryOpportunitiesProps) {
  const authFetch = useAuthFetch();
  const [data, setData] = useState<CarryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCarry = useCallback(async () => {
    try {
      const res = await authFetch('/api/carry');
      if (!res.ok) {
        setData(null);
        return;
      }
      const json = (await res.json()) as CarryResponse;
      setData(json);

      if (onDataLoaded) {
        const top = json.opportunities[0] ?? null;
        onDataLoaded({
          topOpportunity: top
            ? {
                symbol: top.symbol,
                stabilityScore: top.stabilityScore,
                netApr: top.netApr,
                fundingAprGross: top.fundingAprGross,
                userHasMatchingShort: top.userHasMatchingShort,
              }
            : null,
          utilizationPct:
            json.utilizationRate !== null ? json.utilizationRate * 100 : null,
          payingFundingSymbols: json.opportunities
            .filter((o) => o.userIsPayingFunding)
            .map((o) => o.symbol),
        });
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authFetch, onDataLoaded]);

  useEffect(() => {
    fetchCarry();
  }, [fetchCarry]);

  // Hide entirely if loading failed or no opportunities came back
  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
        <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Carry Opportunities</div>
        <div className="text-xs text-[#6e7681] mt-2">Loading…</div>
      </div>
    );
  }

  if (!data || data.opportunities.length === 0) {
    // Don't render if endpoint is completely unavailable (null data)
    if (!data) return null;
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
        <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Carry Opportunities</div>
        <div className="text-xs text-[#6e7681] mt-2">No significant carry opportunities right now.</div>
      </div>
    );
  }

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#21262d]">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">
            Carry Opportunities
          </h2>
          <UtilizationBadge rate={data.utilizationRate} />
        </div>
        {data.loanPoolAvailable && data.borrowRateApr !== null && (
          <div className="text-xs text-[#6e7681]">
            Borrow APR:{' '}
            <span className="text-[#e6edf3]">{(data.borrowRateApr * 100).toFixed(2)}%</span>
          </div>
        )}
        {!data.loanPoolAvailable && (
          <div className="text-xs text-[#6e7681]">Net yield depends on borrow rate — check portfolio page.</div>
        )}
      </div>

      {/* ── Rows ── */}
      <div>
        {data.opportunities.map((opp) => (
          <OpportunityRow
            key={opp.symbol}
            opp={opp}
            loanPoolAvailable={data.loanPoolAvailable}
          />
        ))}
      </div>
    </div>
  );
}
