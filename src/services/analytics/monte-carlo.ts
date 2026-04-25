/**
 * Monte Carlo simulation of future trading outcomes.
 *
 * Model: iid Bernoulli win/loss selection with returns sampled from the
 * trader's empirical return distribution (when `winReturnPcts` /
 * `lossReturnPcts` are provided) or from average win/loss percentages
 * otherwise. Returns are applied multiplicatively
 * (`balance *= (1 + pct/100)`), so gains and losses correctly compound with
 * account size — the equity-based percentages produced by the route caller
 * (`api/analytics/monte-carlo/route.ts`, which uses the reconstructed equity
 * provider) ensure each input pct is "% of equity at that trade", not "% of
 * notional".
 *
 * Outputs:
 * - drawdown probabilities (25%, 50%, ruin) computed per-simulation against
 *   each path's running peak,
 * - final-balance distribution (median, p10, p90, mean),
 * - up to 100 sampled paths for visualisation, and
 * - per-trade-number percentile bands (p5/p25/p50/p75/p95) for the fan chart.
 *
 * Limitations to keep in mind when interpreting:
 * - returns are iid — no autocorrelation, no regime switching, no streaks
 * - position sizing is implicit in the sampled return distribution
 * - win/loss classification is binary (true breakevens drop out at the
 *   caller, not here)
 * - the average-only fallback (no empirical distribution) collapses to two
 *   outcomes per trade, which under-states variance — prefer the empirical
 *   path whenever the caller has the data
 * - the RNG is unseeded `Math.random()`, so results vary slightly between
 *   runs even at 10k sims
 */
export interface MonteCarloInput {
  winRate: number;          // e.g. 0.415
  avgWinPct: number;        // percentage return on wins, e.g. 3.2 (= +3.2%)
  avgLossPct: number;       // percentage return on losses, e.g. -2.8 (= -2.8%)
  tradeCount?: number;      // how many trades to simulate forward (default 100)
  simulations?: number;     // how many paths to run (default 10000)
  initialBalance?: number;  // starting equity (default 10000)
  // Optional: sample from actual percentage-return distribution
  winReturnPcts?: number[];   // actual % returns on winning trades (positive)
  lossReturnPcts?: number[];  // actual % returns on losing trades (negative)
}

export interface MonteCarloResult {
  // Drawdown probabilities
  probDrawdown25: number;  // fraction of sims that hit 25% drawdown
  probDrawdown50: number;  // fraction of sims that hit 50% drawdown
  probRuin: number;        // fraction of sims that went to 0 or below

  // Outcome distribution
  medianFinalBalance: number;
  p10FinalBalance: number;   // 10th percentile (bad case)
  p90FinalBalance: number;   // 90th percentile (good case)
  meanFinalBalance: number;

  // 100 sampled equity curves for visualization (each starts at initialBalance)
  equityCurves: number[][];

  // Percentile bands at each trade number for fan chart ($ values)
  percentileBands: {
    tradeNumber: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  }[];
}

export function runMonteCarloSimulation(input: MonteCarloInput): MonteCarloResult {
  const {
    winRate,
    avgWinPct,
    avgLossPct,
    tradeCount = 100,
    simulations = 10000,
    initialBalance = 10000,
    winReturnPcts,
    lossReturnPcts,
  } = input;

  const useDistribution = !!(winReturnPcts?.length && lossReturnPcts?.length);
  const sampleInterval = Math.max(1, Math.floor(simulations / 100));

  const finalBalances = new Array<number>(simulations);
  const sampledPaths: number[][] = [];

  // tradeBalances[t][s] = balance after trade t in simulation s
  const tradeBalances: number[][] = Array.from(
    { length: tradeCount },
    () => new Array<number>(simulations),
  );

  let hitsDrawdown25 = 0;
  let hitsDrawdown50 = 0;
  let hitsRuin = 0;

  for (let s = 0; s < simulations; s++) {
    let balance = initialBalance;
    let peak = initialBalance;
    let maxDDFrac = 0;
    let hitDD25 = false;
    let hitDD50 = false;
    let hitRuin = false;

    const capture = s % sampleInterval === 0 && sampledPaths.length < 100;
    const pathBuf = capture ? [initialBalance] : null;

    for (let t = 0; t < tradeCount; t++) {
      const isWin = Math.random() < winRate;
      let pct: number;

      if (useDistribution) {
        const dist = isWin ? winReturnPcts! : lossReturnPcts!;
        pct = dist[Math.floor(Math.random() * dist.length)];
      } else {
        pct = isWin ? avgWinPct : avgLossPct;
      }

      // Multiplicative: each trade applies a percentage return to the current balance.
      // This correctly scales gains/losses with account size and compounds realistically.
      balance *= (1 + pct / 100);

      // Ruin handling: once balance hits zero or below, freeze it and fill
      // the remaining trades with 0. Without this guard, a subsequent
      // (1 + pct/100) multiplication on a negative balance flips the sign of
      // future "losses" and produces nonsense paths. A ruin event is by
      // definition a 100% drawdown, so set the DD flags here too — otherwise
      // the bands would under-count drawdown probabilities for paths that
      // ruin before either threshold was tripped on the way down.
      if (balance <= 0) {
        balance = 0;
        hitRuin = true;
        hitDD25 = true;
        hitDD50 = true;
        tradeBalances[t][s] = 0;
        if (pathBuf) pathBuf.push(0);
        for (let t2 = t + 1; t2 < tradeCount; t2++) {
          tradeBalances[t2][s] = 0;
          if (pathBuf) pathBuf.push(0);
        }
        break;
      }

      if (balance > peak) peak = balance;
      if (peak > 0) {
        const dd = (peak - balance) / peak;
        if (dd > maxDDFrac) maxDDFrac = dd;
      }

      if (!hitDD25 && maxDDFrac >= 0.25) hitDD25 = true;
      if (!hitDD50 && maxDDFrac >= 0.50) hitDD50 = true;

      tradeBalances[t][s] = balance;
      if (pathBuf) pathBuf.push(balance);
    }

    if (hitDD25) hitsDrawdown25++;
    if (hitDD50) hitsDrawdown50++;
    if (hitRuin) hitsRuin++;

    finalBalances[s] = balance;
    if (pathBuf) sampledPaths.push(pathBuf);
  }

  const sortedFinals = [...finalBalances].sort((a, b) => a - b);
  const totalBalance = finalBalances.reduce((acc, v) => acc + v, 0);

  const percentileBands = tradeBalances.map((col, t) => {
    const sorted = [...col].sort((a, b) => a - b);
    return {
      tradeNumber: t + 1,
      p5:  Math.max(0, round(quantile(sorted, 0.05), 2)),
      p25: Math.max(0, round(quantile(sorted, 0.25), 2)),
      p50: Math.max(0, round(quantile(sorted, 0.50), 2)),
      p75: Math.max(0, round(quantile(sorted, 0.75), 2)),
      p95: Math.max(0, round(quantile(sorted, 0.95), 2)),
    };
  });

  return {
    probDrawdown25: round(hitsDrawdown25 / simulations, 4),
    probDrawdown50: round(hitsDrawdown50 / simulations, 4),
    probRuin:       round(hitsRuin       / simulations, 4),
    medianFinalBalance: round(quantile(sortedFinals, 0.50), 2),
    p10FinalBalance:    round(quantile(sortedFinals, 0.10), 2),
    p90FinalBalance:    round(quantile(sortedFinals, 0.90), 2),
    meanFinalBalance:   round(totalBalance / simulations, 2),
    equityCurves: sampledPaths,
    percentileBands,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(value: number, digits: number): number {
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}
