/**
 * carry-service.ts — Carry trade opportunity detector for Pacifica unified margin.
 *
 * Three undocumented endpoints (currently testnet-only) are called alongside
 * the standard prices/funding-history endpoints. All three degrade gracefully:
 * - loan_pool unavailable → show gross yield only, borrowRateApr = null
 * - spot_assets unavailable → collateralEnabled = false, ltvRatio = null
 * - account/loan unavailable → userHasSpotBalance = false
 *
 * Base URL: PACIFICA_CARRY_API_URL ?? NEXT_PUBLIC_PACIFICA_API_URL
 * Set PACIFICA_CARRY_API_URL=https://test-api.pacifica.fi in .env.local while
 * these endpoints are testnet-only. When they go live on mainnet, remove it.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface LoanPoolData {
  totalBorrowed: number;
  totalBorrowable: number;
  utilization: number;          // 0-1, danger zone above 0.8
  borrowRateApr: number;        // annual fraction, e.g. 0.01 = 1%
  borrowRateApy: number;
  lendRateApr: number;
  available: boolean;           // false if endpoint unavailable
}

export interface SpotAssetInfo {
  symbol: string;
  collateralEnabled: boolean;
  ltvRatio: number;             // 0-1, e.g. 0.85 for BTC
  active: boolean;
}

export interface UserLoanData {
  borrowed: number;
  pendingInterest: number;
  collateralUtilization: number;
  spotBalances: { symbol: string; amount: number; ltvRatio: number }[];
}

export interface CarryOpportunity {
  symbol: string;

  // Funding side
  currentFundingRateHourly: number;    // e.g. 0.0004
  avgFundingRate24h: number;
  avgFundingRate7d: number;
  fundingRateStdDev24h: number;
  fundingAprGross: number;             // annualised from current rate, %

  // Borrow side
  borrowRateApr: number | null;        // null if loan_pool unavailable
  utilizationRate: number | null;

  // Net yield
  netApr: number | null;               // fundingAprGross - borrowRateApr*100, %
  netAprEstimate: 'high' | 'medium' | 'low' | 'unknown';

  // Asset info
  ltvRatio: number | null;
  collateralEnabled: boolean;

  // Scoring
  stabilityScore: number;              // 1-5
  utilizationWarning: boolean;

  // User context
  userHasSpotBalance: boolean;
  userSpotAmount: number | null;
  userHasMatchingShort: boolean;
  userIsPayingFunding: boolean;        // has position on wrong side paying > 0.03%/hr
  suggestion: string;

  // For display
  markPrice: number;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}
const _cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  return e.data as T;
}

function setCached(key: string, data: unknown, ttlMs: number): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 8_000;

function getBaseUrl(): string {
  return (
    process.env.PACIFICA_CARRY_API_URL ??
    process.env.NEXT_PUBLIC_PACIFICA_API_URL ??
    'https://api.pacifica.fi'
  );
}

async function carryFetch(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Unwrap Pacifica's { success, data } envelope, or return the raw value if it isn't wrapped. */
function extractArray(json: unknown): Record<string, unknown>[] {
  const obj = json as Record<string, unknown> | null;
  const inner = obj?.data ?? json;
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Loan pool state: borrow / lend rates and utilization. Cached 2 min. */
export async function getLoanPool(): Promise<LoanPoolData> {
  const cacheKey = 'carry:loan_pool';
  const cached = getCached<LoanPoolData>(cacheKey);
  if (cached) return cached;

  try {
    const json = await carryFetch(`${getBaseUrl()}/api/v1/loan_pool`) as Record<string, unknown>;
    const data: LoanPoolData = {
      totalBorrowed: Number(json.total_borrowed ?? 0),
      totalBorrowable: Number(json.total_borrowable ?? 0),
      utilization: Number(json.utilization ?? 0),
      borrowRateApr: Number(json.borrow_rate_apr ?? 0),
      borrowRateApy: Number(json.borrow_rate_apy ?? 0),
      lendRateApr: Number(json.lend_rate_apr ?? 0),
      available: true,
    };
    setCached(cacheKey, data, 2 * 60 * 1_000);
    return data;
  } catch {
    console.log('[carry] loan_pool endpoint unavailable — showing gross yields only');
    return {
      totalBorrowed: 0, totalBorrowable: 0, utilization: 0,
      borrowRateApr: 0, borrowRateApy: 0, lendRateApr: 0,
      available: false,
    };
  }
}

/** Active collateral-enabled spot assets with LTV ratios. Cached 10 min. */
export async function getSpotAssets(): Promise<SpotAssetInfo[]> {
  const cacheKey = 'carry:spot_assets';
  const cached = getCached<SpotAssetInfo[]>(cacheKey);
  if (cached) return cached;

  try {
    const json = await carryFetch(`${getBaseUrl()}/api/v1/spot_assets?include_inactive=true`);
    const result: SpotAssetInfo[] = extractArray(json)
      .filter((a) => a.active && a.collateral_enabled)
      .map((a) => ({
        symbol: String(a.symbol ?? ''),
        collateralEnabled: Boolean(a.collateral_enabled),
        ltvRatio: Number(a.ltv_ratio ?? 0),
        active: Boolean(a.active),
      }));
    setCached(cacheKey, result, 10 * 60 * 1_000);
    return result;
  } catch (err) {
    console.warn('[carry] spot_assets unavailable:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Per-user loan state and spot balances. Cached 1 min per wallet. */
export async function getUserLoan(walletAddress: string): Promise<UserLoanData | null> {
  const cacheKey = `carry:user_loan:${walletAddress}`;
  const cached = getCached<UserLoanData>(cacheKey);
  if (cached) return cached;

  try {
    const json = await carryFetch(
      `${getBaseUrl()}/api/v1/account/loan?account=${walletAddress}`,
    ) as Record<string, unknown>;
    const rawBalances = (json.spot_balances as Record<string, unknown>[] | undefined) ?? [];
    const result: UserLoanData = {
      borrowed: Number(json.borrowed ?? 0),
      pendingInterest: Number(json.pending_interest ?? 0),
      collateralUtilization: Number(json.collateral_utilization ?? 0),
      spotBalances: rawBalances.map((b) => ({
        symbol: String(b.symbol ?? b.asset ?? ''),
        amount: Number(b.amount ?? b.balance ?? 0),
        ltvRatio: Number(b.ltv_ratio ?? 0),
      })),
    };
    setCached(cacheKey, result, 1 * 60 * 1_000);
    return result;
  } catch (err) {
    console.warn('[carry] account/loan unavailable:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Strip exchange-specific suffixes to get the base asset symbol. */
function baseSymbol(symbol: string): string {
  return symbol.replace(/-PERP$/i, '').replace(/-USD$/i, '').toUpperCase();
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stddev(xs: number[], avg: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - avg) ** 2, 0) / xs.length);
}

/**
 * Ranked list of carry opportunities across all Pacifica markets.
 * Filters to |fundingAprGross| > 5%. Sorted by stability desc, |netApr| desc.
 * Full result cached 2 min per wallet.
 */
export async function getCarryOpportunities(walletAddress: string): Promise<CarryOpportunity[]> {
  const cacheKey = `carry:opportunities:${walletAddress}`;
  const cached = getCached<CarryOpportunity[]>(cacheKey);
  if (cached) return cached;

  const base = getBaseUrl();

  // Fetch all independent data in parallel
  const [loanPool, spotAssets, userLoan, pricesJson, positionsJson] = await Promise.all([
    getLoanPool(),
    getSpotAssets(),
    getUserLoan(walletAddress),
    carryFetch(`${base}/api/v1/info/prices`).catch(() => null),
    carryFetch(`${base}/api/v1/positions?account=${walletAddress}`).catch(() => null),
  ]);

  const prices = extractArray(pricesJson);
  const positions = extractArray(positionsJson);

  // Build fast lookups
  const spotAssetMap = new Map<string, SpotAssetInfo>(
    spotAssets.map((a) => [a.symbol.toUpperCase(), a]),
  );

  // Filter to symbols with non-trivial funding
  const eligible = prices.filter((p) => Math.abs(parseFloat(String(p.funding ?? '0'))) > 0.00001);

  // Fetch 7-day funding history for all eligible symbols in parallel
  const historyResults = await Promise.all(
    eligible.map(async (p) => {
      const sym = String(p.symbol);
      try {
        const json = await carryFetch(`${base}/api/v1/funding_rate/history?symbol=${sym}&limit=168`);
        const rates = extractArray(json).map((item) =>
          parseFloat(String(item.funding_rate ?? '0')),
        );
        return { symbol: sym, rates };
      } catch {
        return { symbol: sym, rates: [] };
      }
    }),
  );
  const historyMap = new Map<string, number[]>(historyResults.map((h) => [h.symbol, h.rates]));

  const opportunities: CarryOpportunity[] = [];

  for (const price of eligible) {
    const symbol = String(price.symbol);
    const currentFundingRateHourly = parseFloat(String(price.funding ?? '0'));
    const markPrice = parseFloat(String(price.mark ?? '0'));

    // APR filter early — skip before computing history stats
    const fundingAprGross = currentFundingRateHourly * 24 * 365 * 100;
    if (Math.abs(fundingAprGross) <= 5) continue;

    const rates = historyMap.get(symbol) ?? [];
    const rates24h = rates.slice(-24);
    const rates7d = rates;

    const avg24h = rates24h.length ? mean(rates24h) : currentFundingRateHourly;
    const avg7d = rates7d.length ? mean(rates7d) : currentFundingRateHourly;
    const stdDev24h = stddev(rates24h, avg24h);
    const mean24hAbs = rates24h.length ? mean(rates24h.map(Math.abs)) : Math.abs(currentFundingRateHourly);

    // Net APR
    const borrowRateApr = loanPool.available ? loanPool.borrowRateApr : null;
    const netApr = loanPool.available ? fundingAprGross - loanPool.borrowRateApr * 100 : null;

    const netAprEstimate: CarryOpportunity['netAprEstimate'] =
      netApr === null ? 'unknown'
      : Math.abs(netApr) >= 30 ? 'high'
      : Math.abs(netApr) >= 10 ? 'medium'
      : 'low';

    // Stability score (1-5)
    let stabilityScore = 3;
    const sameSign = currentFundingRateHourly * avg7d > 0;
    if (sameSign) {
      const within30 =
        currentFundingRateHourly !== 0 &&
        Math.abs((avg7d - currentFundingRateHourly) / currentFundingRateHourly) <= 0.3;
      if (within30) stabilityScore += 1;
    } else {
      stabilityScore -= 1; // sign flip from 7d average
    }
    if (mean24hAbs > 0 && stdDev24h < mean24hAbs * 0.3) {
      stabilityScore += 1; // low relative volatility
    } else if (mean24hAbs > 0 && stdDev24h > mean24hAbs * 1.0) {
      stabilityScore -= 1; // high relative volatility
    }
    stabilityScore = Math.max(1, Math.min(5, stabilityScore));

    // Asset info — try base symbol first (BTC), fall back to full symbol
    const base_ = baseSymbol(symbol);
    const spotAsset = spotAssetMap.get(base_) ?? spotAssetMap.get(symbol.toUpperCase());
    const ltvRatio = spotAsset?.ltvRatio ?? null;
    const collateralEnabled = spotAsset?.collateralEnabled ?? false;

    // User context
    const userSpotBalance = userLoan?.spotBalances.find(
      (b) => b.symbol.toUpperCase() === base_ || b.symbol.toUpperCase() === symbol.toUpperCase(),
    );
    const userHasSpotBalance = !!userSpotBalance;
    const userSpotAmount = userSpotBalance?.amount ?? null;

    const userHasMatchingShort = positions.some(
      (p) => String(p.symbol).toUpperCase() === symbol.toUpperCase() && String(p.side) === 'short',
    );
    const userIsLong = positions.some(
      (p) => String(p.symbol).toUpperCase() === symbol.toUpperCase() && String(p.side) === 'long',
    );

    // Paying funding: rate < 0 + user is long (per spec), above 0.03%/hr threshold
    const userIsPayingFunding =
      currentFundingRateHourly < -0.0003 && userIsLong && !userHasMatchingShort;

    // Utilization warning
    const utilizationWarning = loanPool.available && loanPool.utilization > 0.7;

    // Suggestion
    const netPct = (netApr ?? fundingAprGross).toFixed(1);
    let suggestion: string;

    if (userHasMatchingShort && userHasSpotBalance) {
      suggestion = `Active carry trade detected. Earning ~${netPct}% APR.`;
    } else if (currentFundingRateHourly < 0 && userIsLong) {
      suggestion = 'You are paying funding. Consider closing or hedging.';
    } else if (userHasSpotBalance && !userHasMatchingShort) {
      const amt = userSpotAmount != null ? userSpotAmount.toFixed(4) : '?';
      suggestion = `You hold ${amt} ${base_} spot. Short on perps to earn carry.`;
    } else {
      suggestion = `Carry available. Deposit ${base_} spot + short perps.`;
    }

    if (loanPool.available && loanPool.utilization > 0.8) {
      const pct = (loanPool.utilization * 100).toFixed(0);
      suggestion += ` Utilization at ${pct}% — borrow rate may spike sharply. Monitor closely.`;
    }

    if (ltvRatio !== null && collateralEnabled) {
      suggestion += ` Collateral efficiency: ${(ltvRatio * 100).toFixed(0)}% LTV.`;
    }

    opportunities.push({
      symbol,
      currentFundingRateHourly,
      avgFundingRate24h: avg24h,
      avgFundingRate7d: avg7d,
      fundingRateStdDev24h: stdDev24h,
      fundingAprGross,
      borrowRateApr,
      utilizationRate: loanPool.available ? loanPool.utilization : null,
      netApr,
      netAprEstimate,
      ltvRatio,
      collateralEnabled,
      stabilityScore,
      utilizationWarning,
      userHasSpotBalance,
      userSpotAmount,
      userHasMatchingShort,
      userIsPayingFunding,
      suggestion,
      markPrice,
    });
  }

  // Sort: stability desc, then |netApr| (or |fundingAprGross|) desc
  opportunities.sort((a, b) => {
    if (b.stabilityScore !== a.stabilityScore) return b.stabilityScore - a.stabilityScore;
    const aApr = Math.abs(a.netApr ?? a.fundingAprGross);
    const bApr = Math.abs(b.netApr ?? b.fundingAprGross);
    return bApr - aApr;
  });

  setCached(cacheKey, opportunities, 2 * 60 * 1_000);
  return opportunities;
}
