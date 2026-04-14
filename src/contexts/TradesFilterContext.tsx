'use client';

/**
 * TradesFilterContext — app-wide trades filter state.
 *
 * Mounted in the trades page so both TradesClient and BoobaChat
 * can read and write the active filter. Booba's tool functions call
 * setTradesFilter() to programmatically apply filters (Part 4 of spec).
 *
 * URL sync and saved-filter logic live in TradesClient; this context
 * is intentionally minimal — just state + setters.
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
} from 'react';

export interface TradesFilter {
  direction: '' | 'long' | 'short';
  tradeTypes: string[];
  assets: string[];
  regimes: string[];
  status: '' | 'open' | 'closed';
  strategyIds: string[];
  playbookId: string;
  playbookAdherence: '' | 'high' | 'low';
  dateFrom: string;
  dateTo: string;
  pnlFilter: '' | 'winners' | 'losers' | 'custom';
  pnlMin: string;
  pnlMax: string;
  signalSource: '' | 'has_signal' | 'no_signal';
  signalCaller: string;
}

export const EMPTY_TRADES_FILTER: TradesFilter = {
  direction: '',
  tradeTypes: [],
  assets: [],
  regimes: [],
  status: '',
  strategyIds: [],
  playbookId: '',
  playbookAdherence: '',
  dateFrom: '',
  dateTo: '',
  pnlFilter: '',
  pnlMin: '',
  pnlMax: '',
  signalSource: '',
  signalCaller: '',
};

export function isFilterActive(f: TradesFilter): boolean {
  return (
    f.direction !== '' ||
    f.tradeTypes.length > 0 ||
    f.assets.length > 0 ||
    f.regimes.length > 0 ||
    f.status !== '' ||
    f.strategyIds.length > 0 ||
    f.playbookId !== '' ||
    f.dateFrom !== '' ||
    f.dateTo !== '' ||
    f.pnlFilter !== '' ||
    f.signalSource !== '' ||
    f.signalCaller !== ''
  );
}

interface TradesFilterContextValue {
  filter: TradesFilter;
  setFilter: (f: TradesFilter) => void;
  /** Partial update — Booba tool functions use this to apply filters by name. */
  setTradesFilter: (partial: Partial<TradesFilter>) => void;
}

const TradesFilterContext = createContext<TradesFilterContextValue | null>(null);

export function TradesFilterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [filter, setFilter] = useState<TradesFilter>(EMPTY_TRADES_FILTER);

  const setTradesFilter = useCallback((partial: Partial<TradesFilter>) => {
    setFilter((prev) => ({ ...prev, ...partial }));
  }, []);

  return (
    <TradesFilterContext.Provider value={{ filter, setFilter, setTradesFilter }}>
      {children}
    </TradesFilterContext.Provider>
  );
}

export function useTradesFilter(): TradesFilterContextValue {
  const ctx = useContext(TradesFilterContext);
  if (!ctx) throw new Error('useTradesFilter must be used within TradesFilterProvider');
  return ctx;
}

// ── URL serialisation helpers ──────────────────────────────────────────────

export function serializeFilterToUrl(f: TradesFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.direction) p.set('direction', f.direction);
  if (f.tradeTypes.length) p.set('tradeTypes', f.tradeTypes.join(','));
  if (f.assets.length) p.set('assets', f.assets.join(','));
  if (f.regimes.length) p.set('regimes', f.regimes.join(','));
  if (f.status) p.set('status', f.status);
  if (f.strategyIds.length) p.set('strategyIds', f.strategyIds.join(','));
  if (f.playbookId) p.set('playbookId', f.playbookId);
  if (f.playbookAdherence) p.set('playbookAdherence', f.playbookAdherence);
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  if (f.pnlFilter) p.set('pnlFilter', f.pnlFilter);
  if (f.pnlMin) p.set('pnlMin', f.pnlMin);
  if (f.pnlMax) p.set('pnlMax', f.pnlMax);
  if (f.signalSource) p.set('signalSource', f.signalSource);
  if (f.signalCaller) p.set('signalCaller', f.signalCaller);
  return p;
}

export function parseFilterFromUrl(p: URLSearchParams): Partial<TradesFilter> {
  const split = (key: string) =>
    p.has(key) ? p.get(key)!.split(',').filter(Boolean) : undefined;

  const out: Partial<TradesFilter> = {};
  const dir = p.get('direction');
  if (dir === 'long' || dir === 'short') out.direction = dir;
  const tt = split('tradeTypes'); if (tt) out.tradeTypes = tt;
  const as = split('assets'); if (as) out.assets = as;
  const rg = split('regimes'); if (rg) out.regimes = rg;
  const st = p.get('status');
  if (st === 'open' || st === 'closed') out.status = st;
  const si = split('strategyIds'); if (si) out.strategyIds = si;
  const pb = p.get('playbookId'); if (pb) out.playbookId = pb;
  const pa = p.get('playbookAdherence');
  if (pa === 'high' || pa === 'low') out.playbookAdherence = pa;
  const df = p.get('dateFrom'); if (df) out.dateFrom = df;
  const dt = p.get('dateTo'); if (dt) out.dateTo = dt;
  const pf = p.get('pnlFilter');
  if (pf === 'winners' || pf === 'losers' || pf === 'custom') out.pnlFilter = pf;
  const pmn = p.get('pnlMin'); if (pmn) out.pnlMin = pmn;
  const pmx = p.get('pnlMax'); if (pmx) out.pnlMax = pmx;
  const ss = p.get('signalSource');
  if (ss === 'has_signal' || ss === 'no_signal') out.signalSource = ss;
  const sc = p.get('signalCaller'); if (sc) out.signalCaller = sc;
  return out;
}
