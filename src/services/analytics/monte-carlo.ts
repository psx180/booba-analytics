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

      if (balance > peak) peak = balance;
      if (peak > 0) {
        const dd = (peak - balance) / peak;
        if (dd > maxDDFrac) maxDDFrac = dd;
      }

      if (!hitDD25 && maxDDFrac >= 0.25) hitDD25 = true;
      if (!hitDD50 && maxDDFrac >= 0.50) hitDD50 = true;
      if (!hitRuin && balance <= 0) hitRuin = true;

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
