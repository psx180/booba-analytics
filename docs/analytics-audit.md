# Analytics Audit — `src/services/analytics/`

Read-only audit. Report location: `analytics-audit.md` at project root
(`/mnt/user-data/outputs/` doesn't exist on this Windows filesystem).

Classification legend:
- **CRITICAL** — computation is wrong; produces misleading results.
- **MODERATE** — valid but statistically suboptimal or potentially misleading.
- **MINOR** — text/label doesn't match computation.
- **COSMETIC** — style, dead code, logging.

Effort: *one-line* / *small change* / *moderate refactor*.

---

## `metrics/risk-metrics.ts`

### CRITICAL — Drawdown percentage is relative to cumulative P&L, not equity
File: `src/services/analytics/metrics/risk-metrics.ts:277-326` (`computeDrawdownAnalysis`)
What's wrong: The drawdown walk initializes `cum = 0; hwm = 0` and then computes
`underwaterPct = |(cum − hwm) / hwm| × 100`. `cum` is cumulative realized P&L
(no starting capital baseline), so the percentage denominator is the highest
*cumulative P&L*, not account equity. Early in the series `hwm` is tiny
(e.g. `$10`), so a `-$500` swing registers as a 5000% drawdown; conversely, a
mature `hwm = $50,000` under-reports the severity of small swings. The
class-level JSDoc advertises these as "worst dollar drawdown / max drawdown as
% of peak equity" (line 17-18), but it's actually % of peak cumulative P&L.
This is the same equity-vs-notional class of bug recently fixed for Sharpe —
except here the denominator is still missing `startingCapital` entirely.
Fix: thread `startingCapital` into `computeDrawdownAnalysis`; compute
`equity = startingCapital + cum`; use that (clamped to ≥ 1) as the HWM
and DD denominator. This also makes `maxDrawdownPercent` compatible with
Calmar, which already uses `startingCapital` in the return series.
Effort: small change.

### CRITICAL — `r2` rounder clashes with the R² concept name
File: `src/services/analytics/metrics/risk-metrics.ts:57-59`
What's wrong: The two-decimal rounder is named `r2()`, matching `r4()` above it.
That's fine in isolation, but the same file also exposes drawdown fields that
elsewhere carry R² semantics (consistency score in the equity-curve aggregator
is called `r2` too). Readers of the module commonly misread `r2(maxDrawdown)`
as "coefficient of determination applied to max drawdown". Not a behaviour
bug, but a readability landmine. Rename to `round2` / `round4`.
Effort: one-line (sed).
*(Downgrade to MODERATE if you weigh readability lower.)*

### MODERATE — Calmar "annualized return" sums per-trade percents
File: `src/services/analytics/metrics/risk-metrics.ts:210-215`
What's wrong: `totalReturnPct = returns.reduce((s, r) => s + r, 0)` adds
per-trade returns that were each denominated by *different* equity-at-entry
values (`pnl / equity_i`). For a growing account the early percents are
weighted heavier than later ones. The comment on line 199-202 acknowledges
this is a simple-return approximation; document or switch to the compound
version (`∏(1+r_i) − 1`, expressed as %). Either option is consistent with
the Sharpe numerator; just pick one.
Effort: small change.

### MODERATE — Downside deviation divides by `n`, Sharpe stddev divides by `n-1`
File: `src/services/analytics/metrics/risk-metrics.ts:70-85`
What's wrong: `stddev()` uses Bessel's correction (`/ (n - 1)`), while
`downsideDeviation()` uses `/ n`. The original Sortino paper uses `/ n` for
downside, so this is defensible, but the inconsistency means Sortino and
Sharpe can disagree on a tiny sample even when semi-deviation equals full
deviation. Add a comment explaining the choice, or standardize.
Effort: one-line comment.

### MODERATE — `recoveryFactor` emits a negative number for losing accounts
File: `src/services/analytics/metrics/risk-metrics.ts:193-196`
What's wrong: Recovery factor is canonically "net profit / max drawdown" — only
meaningful when profit is positive. If `totalPnl < 0`, the code returns a
negative "recovery factor" and the UI happily renders it. Gate on
`totalPnl > 0` and return `null` otherwise.
Effort: one-line fix.

### MINOR — R-multiple fallback conflates invalidationPrice with stop
File: `src/services/analytics/metrics/risk-metrics.ts:405-410`
What's wrong: Comment says "invalidationPrice if stored (treated as stop)" but
`invalidationPrice` is a price the trader entered for "if this were hit the
setup is invalid" — not necessarily where a stop was placed. Worth documenting
or renaming the fallback so the narrative isn't "R-multiple based on your
stop" when it's actually "R-multiple based on your post-hoc invalidation".
Effort: one-line doc fix.

### COSMETIC — Production `console.log`
File: `src/services/analytics/metrics/risk-metrics.ts:240-244`
What's wrong: `console.log(\`[risk] Sharpe: … Sortino: … Calmar: …\`)` left in.
Fine in dev, noisy in prod. Gate behind a `DEBUG_ANALYTICS` flag or remove.
Effort: one-line.

---

## `metrics/xpnl.ts`

### MODERATE — KNN leaks future data (no time split)
File: `src/services/analytics/metrics/xpnl.ts:73-108`
What's wrong: Leave-one-out KNN lets position `i`'s neighbors be drawn from any
other trade in the history — including trades that occurred *after* trade `i`.
A trader's style drifts, so post-hoc neighbors carry information the trader
couldn't have had at entry. The "gap between actual and expected" ceases to
be a skill vs. luck estimate and becomes "how well does my future self predict
my past". For xG analogs this matters: xPnL should only use neighbors strictly
before trade `i`, or at minimum weight prior neighbors more.
Fix: restrict `topKNeighbors` candidates to `j < i` (walk-forward) or use a
time-decay weight. Expect fewer neighbors early in history; gate `xpnl` to
null until `i >= K`.
Effort: moderate refactor (changes the xPnL values, which in turn shift the
luck score in downstream insights and WART entry axis).

### MODERATE — Duplicated feature-name list with stale-copy comment
File: `src/services/analytics/metrics/xpnl.ts:188-208` vs `ml/features.ts:168-181`
What's wrong: `featureColumnNames()` has a JSDoc claiming "copied locally so a
change there can't silently break the column lookup here" — which is exactly
what *would* happen if `features.ts` reorders. The two arrays currently match,
but nothing enforces it. Import `NUMERIC_FEATURE_NAMES` from `../ml/features`
and use it directly; the column lookup via `indexOf` stays correct even if
features.ts reorders. Alternatively, add a unit test asserting they agree.
Effort: one-line change (drop the local copy, import the shared one).

### MODERATE — `luckScore` falls back to 0 when xCum is tiny
File: `src/services/analytics/metrics/xpnl.ts:148-149`
What's wrong: `luckScore = |xCum| > 1e-9 ? (actual - x) / |x| : 0`. A trader
whose xCum happens to be near zero (common on small histories with mixed
neighbors) shows as "neutral" regardless of actual outperformance. At minimum
report this as `null` / `undefined` so the insight narrative can say "not
enough signal" instead of "you're exactly average".
Effort: one-line change.

### MINOR — R² clamped to [0, 1] hides misfit
File: `src/services/analytics/metrics/xpnl.ts:243-257`
What's wrong: R² can legitimately be negative when the predictor is worse than
the mean — a meaningful signal that the xPnL model is underperforming the
trivial "average every trade" benchmark. Clamping to 0 hides model failure.
Let it go negative; the frontend can interpret.
Effort: one-line.

---

## `metrics/elo.ts`

### MODERATE — Condition Elo update asymmetric without documentation
File: `src/services/analytics/metrics/elo.ts:110`
What's wrong: `conditionElo.set(cond, condElo - delta * 0.5)` applies a 0.5
damping factor to the opponent side. Comment (106-109) explains the intent,
but the factor is a magic number that affects the condition-difficulty
rankings. Consider pulling it into a named constant (`CONDITION_DAMPING = 0.5`)
alongside `K_CALIBRATION`/`K_STABLE` so a reader sees it in the tuning block.
Effort: one-line.

### MINOR — Breakeven trades scored as 0.5 without tie-handling documentation
File: `src/services/analytics/metrics/elo.ts:101`
What's wrong: `pnl === 0 → score = 0.5`. In crypto with micro P&L, a true zero
is rare but possible (e.g. liquidated at entry). Document or drop these rows
(or score them as `null` / skip the update).
Effort: one-line.

### MINOR — `computeEloMap` walks twice
File: `src/services/analytics/metrics/elo.ts:140-159`
What's wrong: Comment (142-144) acknowledges this is a second pass purely to
keep the public API clean. Fine for correctness; fix is a small refactor to
have `computeEloResult` return both `result` and `idToElo` in one pass.
Effort: small change.

---

## `metrics/wart.ts`

### MODERATE — Exit axis fallback formula is too lenient
File: `src/services/analytics/metrics/wart.ts:183-184`
What's wrong: Fallback disposition score is `100 − |winnerLoserRatio − 1.2| × 40`.
A bad trader with `ratio = 2.0` (losers held 2× longer) has
`winnerLoserRatio = 0.5`; score = `100 − |0.5 − 1.2|·40 = 72`. A trader who
exits all losers instantly (`winnerLoserRatio → ∞`) caps at 0. The slope is
too gentle for the "losers-held-too-long" direction. Consider asymmetric
penalties: steeper coefficient when `winnerLoserRatio < 1.0`.
Effort: small change.

### MODERATE — Timing axis can exceed 100 before clamping
File: `src/services/analytics/metrics/wart.ts:265-296`
What's wrong: If one session has `$500` in profit and others sum to `−$100`,
`totalPnl = $400` and `pnlShare = 500/400 = 1.25 > 1`. Raw score becomes
`countShare·100 + 1.25·50 = up to 162.5`, divided by 1.5 = 108.3, then
clamped. The clamping works, but the normalization (`/1.5`) assumes pnlShare
≤ 1, which breaks when losing sessions drag totalPnl below the best session.
Compute `pnlShare` against gross positive session P&L instead.
Effort: small change.

### MODERATE — Discipline fallback penalty has a very steep slope
File: `src/services/analytics/metrics/wart.ts:321-324`
What's wrong: `score = 100 − (tiltEpisodeIds.size / total) × 500`. Ten
episodes over fifty trades → score of 0. For the common case (1-2 episodes
in 50 trades → 80-90), fine, but a trader with frequent short episodes gets
zeroed quickly. Consider a `×300` or a log curve; at minimum document
the choice near the constant.
Effort: one-line.

### MINOR — `drawdown.maxDrawdownDuration` unit mismatch risk
File: `src/services/analytics/metrics/wart.ts:226-236`
What's wrong: `equityCurveTradeCount` is passed from the equity-curve
aggregator whose `maxDrawdownDuration` is "consecutive trades underwater"
(`aggregations/equity-curve.ts:57-74`). The WART code correctly reads trades.
But the insight *description* prints "over ${maxDrawdownDuration} trades" —
good. The risk-metrics `drawdown.avgDrawdownDuration` is in *days* however
(`metrics/risk-metrics.ts:299-301`). If the WART dependency ever gets sourced
from the risk-metrics drawdown struct instead of equity-curve's, the unit
flip is silent. Add a strongly-typed field name (`maxDrawdownDurationTrades`)
or invariant comment.
Effort: one-line comment.

### MINOR — Improvement copy on high-entropy fallback references "WART"
File: `src/services/analytics/metrics/wart.ts:372`
What's wrong: Fallback message says "Your trading entropy is high" but the
fallback (tilt-episode density) isn't entropy at all. If entropyResult was
unavailable, the trigger was episode density, not entropy. Update the copy
to match the actually-used method.
Effort: one-line.

---

## `monte-carlo.ts`

### CRITICAL — No file-level or function-level JSDoc
File: `src/services/analytics/monte-carlo.ts:1-141`
What's wrong: Zero documentation. Given the recent fix referenced in the
audit brief ("Monte Carlo uses equity-based returns"), the *implementation*
is now multiplicative/equity-compounded (line 91), but none of the intent,
assumptions, or limitations are written anywhere. This is the module that
drives "probability of 50% drawdown" — a deceptively high-stakes output.
Fix: header JSDoc documenting the inputs, model (iid Bernoulli + sampled %
return), what the fan chart represents, and explicit caveats (no
autocorrelation, no regime switching, etc.).
Effort: small change (docs only).

### MODERATE — Single-outcome mode creates a degenerate bimodal distribution
File: `src/services/analytics/monte-carlo.ts:82-87`
What's wrong: When `useDistribution` is false (the caller didn't provide
empirical distributions), every winning trade returns exactly `avgWinPct` and
every losing trade exactly `avgLossPct`. The simulated paths then have only
two outcomes per step, which collapses variance and produces unrealistically
thin percentile bands. This contradicts the promise of Monte Carlo (modeling
outcome uncertainty). Require empirical distributions (or add Gaussian noise
around the means with the observed variance) before the simulation runs.
Effort: small change.

### MODERATE — No RNG seed, so runs aren't reproducible
File: `src/services/analytics/monte-carlo.ts:79,83-84`
What's wrong: `Math.random()` is seeded from the runtime, so a user hitting
"recompute" gets a different probabilistic headline (`probDrawdown25: 0.42`
one run, `0.38` the next). With 10k sims per run the wobble is small, but
it's visible in screenshots. Accept a `seed?: number` input and use a
seeded PRNG (mulberry32 is 8 lines).
Effort: small change.

### MINOR — `balance` can go negative but ruin check is `balance <= 0`
File: `src/services/analytics/monte-carlo.ts:91,101`
What's wrong: With multiplicative returns, `balance *= 1 + pct/100` where
`pct < -100` (a > 100% loss) produces a negative balance. `hitRuin` fires
correctly at `<= 0`, but the subsequent trade applies `balance *= (1+pct/100)`
to a negative number, so a subsequent "loss" actually increases `|balance|`
toward larger-negative and a "win" drags it back toward zero. Cap at 0 once
ruin is hit, or break out of the inner loop.
Effort: one-line guard.

### MINOR — Percentile bands clamped to ≥ 0 but final balances aren't
File: `src/services/analytics/monte-carlo.ts:122-127,132-137`
What's wrong: `percentileBands` clamps to 0 ("Max(0, …)"), so the fan chart
can't go underwater. `p10FinalBalance` / `meanFinalBalance` are *not* clamped.
If the sim allows negative balance (see previous item) the headlines can be
negative while the chart can't — inconsistent.
Effort: one-line decision.

---

## `insights/revenge-trading.ts`

### MODERATE — P-value minimum-selection creates multiple-testing bias
File: `src/services/analytics/insights/revenge-trading.ts:114-116`
What's wrong: Runs both Welch on P&L and chi-squared on win rate, then uses
`primaryTest = pnlTest.pValue <= winRateTest.pValue ? pnlTest : winRateTest`
to form the headline. That's selection on minimum p-value — doubles the
Type-I error. The global BH pass in statistics.ts helps because it sees
*both* statistics in `insight.statistics`, but the narrative copy and
severity use the selected-min and will claim significance twice as often
as 5%. Report both tests in the description without choosing a primary.
Effort: small change.

### MODERATE — No minimum sample on the `normalTrades` side
File: `src/services/analytics/insights/revenge-trading.ts:86-97`
What's wrong: Guard is `if (revengeTrades.length < 2)` but nothing prevents
`normalTrades.length < 2`. Since qualified ≥ 30 and revenge < 30 to fire, the
normal side should be comfortable — but if a user is deeply in a tilt state
for long runs, revenge could exceed 28 and leave `normal < 2`. Welch then
returns its insufficient-data fallback (fine) but the downstream narrative
claims a comparison that isn't there.
Effort: one-line guard.

### MINOR — Signal-phrase copy drifts from the actual test
File: `src/services/analytics/insights/revenge-trading.ts:125-128`
What's wrong: `usingTiltSignal = sorted.some((p) => p.tiltScore != null)` — if
*any* position has a tilt score the phrase switches to "tilted state", even
though per-position classification may still use the 15-minute heuristic for
the ones with null scores (line 64-80). In mixed populations the description
under-represents what the code actually did. Either make the fallback binary
(all or nothing) or report both sources.
Effort: small change.

---

## `insights/disposition.ts`

### MODERATE — Picks the smaller of two p-values (same bias as revenge)
File: `src/services/analytics/insights/disposition.ts:70-71`
What's wrong: `primaryTest = pgrTest.pValue < holdTimeTest.pValue ? pgrTest : holdTimeTest`.
The two tests are on related but distinct quantities (hold times vs. their
reciprocals), so min-p-value selection again inflates type I. Consider
running both as independent evidence, reporting both p-values without
selecting, and letting global BH handle the correction.
Effort: small change.

### MODERATE — Welch's t-test on `1 / holdTime` is ill-conditioned
File: `src/services/analytics/insights/disposition.ts:54-67`
What's wrong: PGR/PLR proxy uses `1/holdTime`. Short holds (1s) → 1.0;
typical holds (1h = 3600s) → 2.8e-4. That's a four-orders-of-magnitude
spread with a *very* heavy right tail — Welch's normality assumption breaks
badly. Use a Mann-Whitney U test (or run Welch on log-hold-time, then
interpret the sign) to get a test whose p-value reflects the actual data.
Effort: moderate refactor (add a non-parametric test to statistics.ts).

### MINOR — `estimatedCost` formula is cryptic and double-counts `loserCount`
File: `src/services/analytics/insights/disposition.ts:75-79`
What's wrong: `avgLossPerSecond = |totalLossPnl| / (loserCount × avgLoserHold)`,
then `estimatedCost = extraHoldSeconds × avgLossPerSecond × loserCount`. The
`loserCount`s cancel, giving `|totalLossPnl| × extraHoldSeconds / avgLoserHold`.
Correct — but the variable arithmetic reads as if it's counting the same
loser count twice. Simplify the expression and document.
Effort: one-line simplification.

---

## `insights/overtrading.ts`

### MODERATE — Sign of correlation overridden by mean comparison
File: `src/services/analytics/insights/overtrading.ts:79-87`
What's wrong: `isNegativeCorr = avgHeavy < avgLight`. Then
`rSign = isNegativeCorr ? '-' : '+'; rStr = \`r=${rSign}...\``. This
constructs a signed Pearson r by *overriding* the actual correlation sign
with the mean comparison. For skewed days (a handful of high-count good days
pulling up avgHeavy while the actual r is mildly negative) the description
will say `r = +0.04` while statistics.ts computed `|r| = 0.04` from
significantly-negative raw r. Return signed r from pearsonCorrelation (or
compute it locally), don't fabricate it from the mean split.
Effort: small change.

### MODERATE — Pair of tests with no within-detector correction
File: `src/services/analytics/insights/overtrading.ts:61,82-83,102`
What's wrong: Runs `pearsonCorrelation` and `welchTTest`, uses
`primaryTest = tTest.pValue < corrTest.pValue ? tTest : corrTest` and
reports `isSignificant = either.isSignificant`. Same min-p-value selection
issue as revenge/disposition. Either run both through local Bonferroni or
report them as independent evidence.
Effort: small change.

### MINOR — Median picks the upper element on even-length inputs
File: `src/services/analytics/insights/overtrading.ts:64-65`
What's wrong: `median = sortedCounts[Math.floor(n / 2)]`. For `n = 6` this
returns index 3 (4th value) — that's the upper quartile-ish estimate, not
the true median. Downstream the description says "on days with median+1 or
more"; the off-by-one is minor but the copy can read weird at small n.
Effort: one-line fix (standard midpoint average).

---

## `insights/time-of-day-edge.ts`

### CRITICAL — "Optimal cutoff" selection then tested on the same data
File: `src/services/analytics/insights/time-of-day-edge.ts:253-274`
What's wrong: The fatigue analysis picks `bestN` by *maximizing* early-session
average P&L across all candidate cutoffs in `[1, maxTradesPerDay-1]`, then
runs Welch's t-test comparing `trades 1..bestN` vs `bestN+1..`. This is a
textbook data-snooping bias — the splitting point was chosen to *maximize*
the difference the t-test then evaluates. Under the null hypothesis (no
fatigue), this procedure still finds "significant" differences far more
than 5% of the time. The slopeTest at line 251 (OLS slope significance)
*is* a legitimate global fatigue test and is used as the `isSignificant`
gate — good — but the reported `estimatedSavings` and `optimalCutoff`
inherit the bias.
Fix options (in order of rigor): (a) show the optimal-cutoff narrative
only when `slopeTest.isSignificant`, never as standalone (already done for
`isSignificant`, but the Welch test and `estimatedSavings` still get
reported when the slope test passes — consider removing them or annotating
as "selected post-hoc, interpret cautiously"); (b) hold out the last 20% of
trades, pick `bestN` on the first 80%, evaluate on the held-out slice.
Effort: moderate refactor (Option B); small change (Option A).

### MODERATE — 24-hour multiple comparisons without per-detector correction
File: `src/services/analytics/insights/time-of-day-edge.ts:68-90,131-134`
What's wrong: Tests every hour with ≥10 trades against its complement. Up to
24 tests. Comment line 92 ("raw p-values; global BH handles multiplicity")
is correct — but the *narrative* (line 98-103) uses `significant.length > 0`
to pick a best/worst. Under BH across detectors the marginal hours likely
get marked non-significant, but the description doesn't reflect the
post-correction state. Use `correctionApplied` flag on each test when
computing `significant` for the narrative.
Effort: small change.

### MINOR — `fatigueDescription` reports slopeTest while narrative cares about Welch
File: `src/services/analytics/insights/time-of-day-edge.ts:148-152`
What's wrong: The non-significant branch says `(${fatigue.slopeTest.description})`
which is the correct gate; the significant branch says `(${fatigue.test.description})`
which is the selected-best Welch (biased). Flip to always print the slopeTest
result since that's what actually gates significance.
Effort: one-line.

---

## `insights/tilt-episodes.ts`

### MODERATE — Trigger inference re-derivation drifts from change-point detector
File: `src/services/analytics/insights/tilt-episodes.ts:120-141`
What's wrong: The insight doesn't read the actual trigger stored on the
episode; it re-infers one from the prior-5-loss count. The comment
acknowledges this ("keeps us aligned with the change-point detector's logic
without coupling") but the change-point detector has richer trigger logic
(large_loss, drawdown via magnitude, behavioral_shift — see
`tilt/change-point.ts:295-309`). This insight will never label a trigger as
`large_loss` since the re-inferred set is only {consecutive_losses, drawdown,
behavioral_shift}. `humanTrigger` supports `large_loss` (line 220) but it's
unreachable from this detector.
Fix: pass the stored episode trigger through via the episode row (add a
`tiltEpisodeTrigger` field) or compute once in the tilt service and store.
Effort: moderate refactor.

### MINOR — Counterfactual assumes skipped trades = $0 outcome
File: `src/services/analytics/insights/tilt-episodes.ts:143-148`
What's wrong: `pausedTotalPnl = totalOutside; improvement = pausedTotalPnl - realTotalPnl`.
Under the "if you had paused" counterfactual, skipped trades produce $0, not
the pre-pause trader's expected P&L. That's a defensible strong-form assumption
but the description just says "if you had paused trading" and doesn't flag the
assumption. Mention it.
Effort: one-line copy fix.

---

## `insights/streak-behavior.ts`

### MODERATE — Four tests + min-p-value pick
File: `src/services/analytics/insights/streak-behavior.ts:131-144`
What's wrong: `winSizeTest`, `lossSizeTest`, `winPnlTest`, `lossPnlTest` all
run, then `primaryTest = allTests.reduce((b,t) => t.pValue < b.pValue ? t : b)`
and `isSignificant = allTests.some(t => t.isSignificant)`. Four tests on three
groups (win/loss/neutral) with the selected-minimum-p reported as headline.
Bonferroni would drop α to 0.0125; BH across all insights helps but within-
detector should use corrected thresholds for the narrative gate.
Effort: small change.

### MINOR — `affectedPositions` can duplicate if a trade is in both streak lists
File: `src/services/analytics/insights/streak-behavior.ts:187`
What's wrong: `[...winStreak, ...lossStreak].map(p => p.id)`. A position is
labeled exactly one of win/loss/neutral so no overlap in practice, but the
concat is loose — an invariant better-expressed via `Set`.
Effort: one-line.

---

## `insights/size-escalation.ts`

### MODERATE — Two tests, min-p-value picked
File: `src/services/analytics/insights/size-escalation.ts:92-94`
What's wrong: `primaryTest = outcomeTest && outcomeTest.pValue < sizeTest.pValue ? outcomeTest : sizeTest`.
Same class of bias as revenge/overtrading. Document or report both.
Effort: small change.

### MINOR — Breakeven prior trade silently drops the current trade
File: `src/services/analytics/insights/size-escalation.ts:45-49`
What's wrong: Only `prevPnl < 0 | > 0` cases push. A prior breakeven trade
(pnl === 0) causes the current to be dropped from both groups. This is fine
with modern data (breakevens are rare on Pacifica) but worth documenting.
Effort: one-line.

---

## `insights/sizing-analysis.ts`

### MODERATE — Multiple tests without correction, impact can mask insignificance
File: `src/services/analytics/insights/sizing-analysis.ts:211-219`
What's wrong: Collects up to three tests (`regimeSizeTest`, `regimeLossTest`,
`sizeVsPnlTest`) and sets `isSignificant = statsSet.some(t => t.isSignificant)`.
No within-detector correction. Narrative severity and "warning" path gated on
similar OR logic. Run Bonferroni across the three or report them separately.
Effort: small change.

### MINOR — Kelly formula assumes binary win/loss and stable edge
File: `src/services/analytics/insights/sizing-analysis.ts:85-95`
What's wrong: `b = avgWin / avgLossAbs; kellyF = (winRate*b - (1-winRate)) / b`.
Correct for a 2-outcome bet. But crypto P&L is continuous with fat tails; Kelly
over binary means drastically overstates the safe fraction. The copy does say
"reference point, not a prescription" (line 92), which is fine, but the
computation is quietly binary-discretizing a continuous return. Document the
approximation.
Effort: one-line doc.

### MINOR — `rawPearsonR` locally re-implements a signed correlation
File: `src/services/analytics/insights/sizing-analysis.ts:315-330`
What's wrong: Duplicates a signed Pearson r because `statistics.ts`
`pearsonCorrelation` only returns `|r|`. Same pattern as overtrading. Adding
a `signedR` field to `StatisticalTest` (or returning `r` separately) removes
this per-module duplication.
Effort: small change (refactor statistics.ts to expose signed r).

---

## `insights/exit-optimizer.ts`

### CRITICAL — Projected-gain formula scales inversely with current efficiency
File: `src/services/analytics/insights/exit-optimizer.ts:93-98`
What's wrong:
```
factor = 0.2 / worstEntry[1].stats.avgEfficiency;
projectedGain = totalLeftOnTable * factor;
```
Comment claims "20% absolute efficiency improvement in worst regime". If
`avgEfficiency = 0.1`, `factor = 2.0`, so projected gain = `2 × totalLeftOnTable` —
i.e. you somehow recover *twice* what was left on the table. That's
impossible by construction (LOT = potential − captured; you can't recover
more than LOT).
Correct "20 percentage points of absolute efficiency improvement" math:
`fraction_of_LOT_recovered = 0.20 / (1 − avgEfficiency)`, so `projectedGain
= totalLeftOnTable × 0.20 / (1 − avgEfficiency)`. For `avgEfficiency = 0.1`
that's `0.222 × LOT`, not `2.0 × LOT`.
Fix: denominator should be `(1 − avgEfficiency)`, not `avgEfficiency`.
Effort: one-line fix.

### MODERATE — Dead re-indexing block
File: `src/services/analytics/insights/exit-optimizer.ts:80-83`
What's wrong:
```
let testIdx = 0;
for (const regime of Object.keys(regimeResults)) {
  regimeResults[regime].test = allRegimeTests[testIdx++];
}
```
This re-assigns each `.test` to the same value it already had (insertion
order is preserved in `Map.entries` and `Object.keys` on insertion-ordered
records). Either remove the dead loop or document its intent.
Effort: one-line (delete).

### MINOR — `leftOnTableRatio` goes to Infinity on non-positive totalPnl
File: `src/services/analytics/insights/exit-optimizer.ts:101-102`
What's wrong: `leftOnTableRatio = totalPnl > 0 ? overall.totalLeftOnTable / totalPnl : Infinity`.
A breakeven/losing trader gets `Infinity`, which trips `severity = 'warning'`
regardless of how much was left on table. Use `maxEquity` or `|totalPnl|`,
or gate severity differently.
Effort: one-line.

---

## `insights/hold-time-optimizer.ts`

### CRITICAL — Best-vs-worst quartile selection is selection on extremes
File: `src/services/analytics/insights/hold-time-optimizer.ts:81-96`
What's wrong: Splits positions into four hold-time quartiles, picks the best
and worst quartile by mean P&L, then runs Welch comparing just those two. This
is equivalent to maximizing (then testing) the group-mean difference across
`C(4,2) = 6` possible pairings. Under the null, the max-difference pair
reliably looks "significant" much more than 5% of the time. The quartile
extremes by definition bound the range — any finite sample has one.
Fix options: (a) run a one-way ANOVA or Kruskal-Wallis across all four
quartiles as the gating test, report best/worst pairs descriptively only;
(b) Bonferroni-correct the Welch at α/6; (c) use Tukey's HSD for post-hoc
comparisons.
Effort: moderate refactor.

### MODERATE — `outsidePnls` uses Array.includes on full Position objects
File: `src/services/analytics/insights/hold-time-optimizer.ts:98`
What's wrong: `tradePositions.filter((_, i) => !quartiles[bestIdx].includes(_))`.
`.includes` on an object array uses reference equality (works, since objects
are identical references through the sort) but makes the computation O(n²)
per trade-type, and the pattern of a leading `_` that's then referenced by
name inside the predicate is unusual. Convert `quartiles[bestIdx]` to a
`Set` first.
Effort: one-line.

### MINOR — `totalActualPnl` variable is actually a mean
File: `src/services/analytics/insights/hold-time-optimizer.ts:102`
What's wrong: `const totalActualPnl = mean(tradePositions.map(p => p.aggregatePnl!))`
— the variable name says "total", the value is the average. Rename to
`avgActualPnl` to match.
Effort: one-line.

---

## `insights/outlier-dependency.ts`

### MODERATE — Dummy `StatisticalTest` with pValue=1 but isSignificant derived elsewhere
File: `src/services/analytics/insights/outlier-dependency.ts:69-79,126`
What's wrong: `dummyTest` has `isSignificant: false, pValue: 1`, but the
Insight's `isSignificant` is set to `isDependentOnOutliers`. When the global
BH pass runs (`statistics.ts:298-350`), the insight's isSignificant gets
*overwritten* to `some(t => t.isSignificant)` — and since the only test
has `isSignificant: false`, the BH pass will always turn this insight's
significance off. Either mark the test as `isSignificant: isDependentOnOutliers`
when the threshold is met (with testName='descriptive', honored by
`DESCRIPTIVE_MODULES` gating), or exempt this module from the BH reset.
Effort: small change.

### MINOR — "Top 10%" can include losing trades when total is small
File: `src/services/analytics/insights/outlier-dependency.ts:42-49`
What's wrong: `top10Count = max(1, round(n × 0.1))`. For `n = 20`, top 10% is
2 trades. If fewer than 2 trades are winners, the top-10% slice includes a
zero or losing trade and the "account for X% of P&L" sentence becomes
confusing ("top 2 trades drive 200% of P&L" is technically true but weird).
Clamp `topPct` to a sensible cap or gate by winners-only.
Effort: small change.

---

## `insights/entropy-insight.ts`

### MODERATE — Direction-after-outcome chi-squared collapses direction dimension
File: `src/services/analytics/insights/entropy-insight.ts:115-126,319-338`
What's wrong: The chi-squared backing test uses only `afterWinLong / afterWinTotal`
vs. `afterLossLong / afterLossTotal` — just testing whether long-rate depends
on prior outcome. A trader may react to losses by switching *instrument* or
*size* (common) without changing direction. The test will be non-significant
while the entropy score correctly flags scattered discipline. The insight
label then says "decision consistency" is based on entropy (which measures
five dimensions) but significance (and therefore BH survival) hinges on one
dimension. Either use conditional entropy itself with a bootstrap p-value,
or add tests across all five dimensions and BH-correct.
Effort: moderate refactor.

### MINOR — `combinations` is defined but unused in entropy-insight
Wait — that was in combinatorial-search.ts. In entropy-insight: no dead
combinations; move on.

### COSMETIC — `sessionFromHour` hardcodes UTC boundaries
File: `src/services/analytics/insights/entropy-insight.ts:354-359`
What's wrong: Session boundaries are `< 6 → asian`, etc. OK for UTC, but
doesn't match the `entrySession` field the rest of the codebase uses
(which is typically enum-indexed from a dedicated classifier). Consider
reusing the same session classifier.
Effort: small change.

---

## `insights/combinatorial-search.ts`

### MODERATE — Dead `combinations` helper
File: `src/services/analytics/insights/combinatorial-search.ts:518-533`
What's wrong: `combinations<T>()` is defined but never called — exhaustive
search was disabled in favor of `REGISTERED_PAIRS`. Harmless but it's
eighteen lines of unused code.
Effort: one-line (delete).

### MINOR — Fixed `50` dollar assumption in Markov isn't in this file (cross-ref)
That's ml-patterns.ts line 291; not an issue here.

### COSMETIC — `console.log` for stats
File: `src/services/analytics/insights/combinatorial-search.ts:211-215`
Same as risk-metrics: hide behind a debug flag.
Effort: one-line.

---

## `insights/regime-mismatch.ts`

### CRITICAL — `isSignificant: true` is hard-coded on the insight
File: `src/services/analytics/insights/regime-mismatch.ts:210`
What's wrong: The insight payload sets `isSignificant: true` regardless of the
stats it attaches. Since `findings.length === 0` is the only other branch
(which returns a non-significant pending stub), significance of the positive
branch hinges on `sigComps.length === 0` (line 115) — which is the gating
filter that keeps only pairwise comparisons where *at least one of two*
tests was significant. Fine at the findings level, but:
 (a) The global BH pass uses `insight.statistics.some(t => t.isSignificant)`
     to overwrite the insight's `isSignificant` after correction. Since
     many tests are attached (`top.tests` — all allTests for that trade
     type, which includes non-significant pairs), the BH pass will typically
     retain one as significant. So the hard-coded `true` gets overwritten
     correctly in practice.
 (b) But between `detect()` emission and the BH pass, `isSignificant: true`
     is stale/misleading. Cleaner to set it from `sigComps.length > 0 &&
     top.tests.some(t => t.isSignificant)`.
Effort: one-line fix.

### MODERATE — All pairwise tests attached (not just the winning pair)
File: `src/services/analytics/insights/regime-mismatch.ts:207`
What's wrong: `top.tests = allTests` — the full set of pairwise comparison
stats across every regime pair for the top tradeType. For 4 regimes that's
`4C2 × 2 = 12` tests per tradeType; all go to the BH pipeline. The BH
correction will then consider all of them as independent hypotheses for
this one insight, diluting significance.
Fix: attach only the `best` pair's tests (`allTests[best.pnlTestIdx]`,
`allTests[best.winRateTestIdx]`). The other pairs informed the choice but
shouldn't contribute to the correction denominator twice.
Effort: small change.

---

## `insights/xpnl-insight.ts`

### MODERATE — Paired data tested with Welch (unpaired)
File: `src/services/analytics/insights/xpnl-insight.ts:42-44`
What's wrong: `actuals` and `expecteds` are *paired* — each xPnL is the KNN
prediction for its corresponding actual trade. Welch's t-test treats them as
independent samples and ignores the pairing. The correct test is a paired
t-test (or Wilcoxon signed-rank for non-parametric). The unpaired version
has lower power and slightly inflated variance estimates.
Fix: run the paired t-test on `actuals[i] − expecteds[i]` against μ=0;
add to statistics.ts.
Effort: small change (add paired test helper).

### MINOR — Description always says "Skill vs Luck Analysis (xPnL)"
File: `src/services/analytics/insights/xpnl-insight.ts:58,69,81`
What's wrong: The three branches all assign the same title. Harmless but
a clue that a switch/templating refactor was abandoned.
Effort: one-line (keep or consolidate).

---

## `insights/wart-insight.ts`

### MODERATE — Chi-squared test's group B is a fabricated 50/50
File: `src/services/analytics/insights/wart-insight.ts:66-69`
What's wrong:
```
chiSquaredProportionTest(winners, total, round(total/2), total)
```
passes `winners / total` against `round(total/2) / total`, i.e. the trader's
actual win rate against a fabricated "exactly half wins" at the same sample
size. A proper test of win rate vs 50% would use a one-sample proportion z-test
or a binomial exact test against p=0.5. The current form effectively compares
one sample against a hypothetical N-sized group at 50% — it gets the right
expected proportion but inflates the effective sample size to 2N.
Fix: add `binomialProportionTest(k, n, p0=0.5)` to statistics.ts or use
Fisher's exact against a synthetic 50% sample of the same size (statistically
equivalent to one-proportion when expected counts ≥ 5, but clearer intent).
Effort: small change.

### MINOR — Improvement copy reads first improvement even if axis score is high
File: `src/services/analytics/insights/wart-insight.ts:73,80`
What's wrong: `headline = wart.improvements[0] ?? ''`. `wart.buildImprovements`
always returns at least one string when any axis exists (fallback at line
348 of wart.ts). So a trader with all axes above 60 still gets a
"improvement" sentence — usually a tepid "your best session is X" type. Add
a threshold here: only include headline if the worst axis < 60.
Effort: one-line.

---

## `insights/liquidation.ts`

### MODERATE — Synthetic `pValue: 0.001` with `isSignificant: true` is a shortcut
File: `src/services/analytics/insights/liquidation.ts:35-45`
What's wrong: Every liquidation event emits a fabricated "test" with
`pValue: 0.001, effectSize: 1.0, isSignificant: true`. When BH runs across
all insights, this synthetic test always enters rank 1 (smallest p-value),
pushing the BH threshold boundary. Any other p-value at rank k where
`p_k ≤ (k/m) × 0.10` will now survive, which is the correct behavior *if*
we genuinely think a liquidation is irrefutable evidence. But the implementation
concern is that the test isn't actually a statistical test at all — it's an
existence check dressed up. Either exempt this module from the BH pipeline
(descriptive tier) or use a `k` proportion test against the expected liquidation
rate (zero, or a baseline).
Effort: small change (exempt via `DESCRIPTIVE_MODULES` if that gate exists).

### MINOR — `totalCost = sum(aggregatePnl)` includes any positive "liquidation" P&L
File: `src/services/analytics/insights/liquidation.ts:31`
What's wrong: Sums aggregatePnl for all liquidated positions. Pacifica
liquidations can in rare cases close at a gain (e.g. liquidation at favorable
price during volatile micro-windows). The description reads "totalCost" but
a positive value flips the meaning. Clamp to `Math.min(0, sum)` or rename.
Effort: one-line.

---

## `insights/ml-patterns.ts`

### MODERATE — Cluster-improvement estimate is selection-biased
File: `src/services/analytics/insights/ml-patterns.ts:118,122-125`
What's wrong: Estimated delta = `(best.avgPnl − worst.avgPnl) × worst.tradeCount × 0.5`.
Best and worst are *selected from k clusters by avg P&L*, so the extremes are
inflated. The 0.5 factor dampens but doesn't correct for that. Add a caveat
to the description ("assuming you could halve the worst-cluster trades")
and/or gate the estimate on the silhouette score.
Effort: small change.

### MODERATE — Markov insight multiplies by a hardcoded $50
File: `src/services/analytics/insights/ml-patterns.ts:291`
What's wrong: `dollarImpact = excessLossLoss × lossesAfterLoss × 50`.
The `50` is unexplained magic ("average loss magnitude" per the comment,
but the average loss is available from the input positions). Use the
actual average loss magnitude instead.
Effort: one-line.

### MINOR — Anomaly test's `isSignificant: false` suppresses warnings
File: `src/services/analytics/insights/ml-patterns.ts:244`
What's wrong: Anomaly insight sets `isSignificant: false` even when the
insight severity is `'warning'`. Reasonable per DESCRIPTIVE_MODULES
policy, but the downstream "warning" badge + `isSignificant: false`
combination can confuse the consumer UI. Document.
Effort: one-line comment.

---

## `insights/social-correlation.ts`

### MODERATE — Gap threshold applied pre-test, not post-test
File: `src/services/analytics/insights/social-correlation.ts:49-51`
What's wrong: Gates the insight on `gap < MIN_WIN_RATE_GAP` *before* the
chi-squared test runs. A trader with a 9-pp gap (chi-squared p = 0.001)
produces no insight; a trader with a 10-pp gap on tiny samples (p = 0.4)
produces an insight flagged non-significant. Better: run the test first,
report on statistical significance with absolute gap as a magnitude
annotation.
Effort: small change.

### MINOR — `impactScore` multiplies gap by confidence only on significance
File: `src/services/analytics/insights/social-correlation.ts:90`
What's wrong: `impactScore: isSignificant ? gap × confidence : 0`. If
non-significant, all ranking information is lost. Cross-detector ranking
already uses `(1 − pValue)` downweighting; force-zeroing is redundant.
Effort: one-line.

### MINOR — `category: 'social' as never` — cast silences a type check
File: `src/services/analytics/insights/social-correlation.ts:91`
What's wrong: `as never` casts past the `Insight['category']` union type.
Add 'social' to the canonical category type (or replace with an allowed
one like 'strategy'/'risk').
Effort: one-line type fix.

---

## `convergence.ts`

### MODERATE — Stale-field fallback for `isSignificant` persists into UI
File: `src/services/analytics/convergence.ts:263-269`
What's wrong: `hasFatigue = fatigue.isSignificant === true` (strict equality,
so missing/undefined → false). Comment explicitly notes "older stored
observations predate the isSignificant flag; treat missing as not significant
so stale fatigue cards stop surfacing". Correct safety net, but once all
observations are recomputed the old logic will keep silently dropping any
observation where the detector writes `false` — which is correct. No bug,
just documentation the invariant.
Effort: one-line (promote comment to a doc block).

### MINOR — `detectRiskManagement` thresholds are magic numbers
File: `src/services/analytics/convergence.ts:451-476`
What's wrong: `highCv = cv > 5`, `lowSharpe = sharpe < 0.3`, `lowPayoff =
payoff < 1.0`, `elevatedDrawdown = current > avg × 1.5`. Pulling these into
named constants at the top of the file (like `ACTIONABILITY`) improves
readability and makes tuning explicit.
Effort: small change.

---

## `walk-forward.ts`

### MODERATE — Persistence check requires `lastAvg > firstAvg × 0.8`
File: `src/services/analytics/walk-forward.ts:258-259`
What's wrong: `edgePersistent = lastAvg > 0 && firstAvg > 0 && lastAvg > firstAvg * 0.8`.
If a trader improved from $1 expectancy to $50 across windows, persistent.
If they held steady at $50, persistent. If they dropped from $50 to $45
(hint of decay), non-persistent — the 80% threshold is asymmetric: an 80%
floor for persistence but any drop below zero triggers degradation. Consider
symmetric bands or a signed-slope test.
Effort: small change.

### MINOR — `stddev` and `downsideDeviation` both divide by `n`
File: `src/services/analytics/walk-forward.ts:92-98,106-112`
What's wrong: Population denominator (no Bessel correction) — diverges from
risk-metrics.ts's Sharpe stddev, which uses `n - 1`. Pick one convention.
Effort: one-line.

### MINOR — `improvePct` computation uses `firstAvg`, which can be small
File: `src/services/analytics/walk-forward.ts:282-286`
What's wrong: `improvePct = ((lastAvg − firstAvg) / |firstAvg|) × 100`.
If first window happens to be near zero ($0.10 per trade), even trivial
absolute improvements read as thousands of percent. Guard with a minimum
magnitude floor.
Effort: one-line.

---

## `equity/reconstructed.ts`

### MODERATE — `getStartingCapital` first-deposit fallback ignores later corrections
File: `src/services/analytics/equity/reconstructed.ts:24-34`
What's wrong: Returns the *first* deposit's amount. A user who made a $10
test deposit before depositing $10,000 gets `10` as starting capital, which
then anchors every per-trade-return denominator. Fallback to `10000` if
`amount < threshold` (e.g. < $100) or sum the first N deposits within a
grace window.
Effort: small change.

### MINOR — Two `console.log`s after series build
File: `src/services/analytics/equity/reconstructed.ts:133-145`
What's wrong: Production logs of equity series summaries. Hide behind debug
flag.
Effort: one-line.

### MINOR — Quadratic cost noted in comment but not bounded
File: `src/services/analytics/equity/reconstructed.ts:61-62`
What's wrong: Comment ("N cash flows × M positions is trivial at our scale")
documents the O(N·M) filter; acceptable today but the forward-pointer
alternative is mentioned and not implemented. Add a guard/`TODO` with a
clear trigger (e.g., `if (cashFlows.length * closed.length > 1e6) …`).
Effort: one-line.

---

## `aggregations/equity-curve.ts`

### CRITICAL — Sync aggregator's drawdown % uses cum-P&L, not equity
File: `src/services/analytics/aggregations/equity-curve.ts:46-98`
What's wrong: `cumulative` starts at 0, `hwm` starts at 0, then
`underwaterPct = ((cum − hwm) / max(|hwm|, 1)) × 100`. Same root cause as
the risk-metrics drawdown bug above — the denominator is cumulative P&L,
not equity. For early history, underwaterPct can exceed 100% in magnitude.
Most consumers currently use the async path (which routes through
`computeDrawdownSummary` with real equity), but the sync `aggregate` still
ships this value as `currentDrawdownPct`, `maxDrawdownPct`. The WART risk
axis, for example, reads from `equityResult.data.maxDrawdownPct` which
might come from either path.
Fix: require startingCapital in the sync aggregator or deprecate/remove
the sync path in favor of `getEquityCurveAsync`.
Effort: moderate refactor.

### MINOR — `underwaterPct` not clamped to [-100, 0]
File: `src/services/analytics/aggregations/equity-curve.ts:69`
What's wrong: `underwaterPct = (underwater / denom) * 100`. Mathematically ≤ 0,
but the magnitude can blow past 100% when the hwm is small. The async path
explicitly clamps (line 123 of reconstructed.ts); the sync path does not.
Effort: one-line clamp.

### MINOR — `consistency` (R² of equity ~ trade index) drops negative R²
File: `src/services/analytics/aggregations/equity-curve.ts:131-138`
What's wrong: `max(0, min(1, r2))`. A negative R² from simple-statistics
would mean the linear fit is worse than the mean — a meaningful anti-pattern
in equity curves (high variance/choppy P&L). Clamp hides it.
Effort: one-line.

---

## `aggregations/performance.ts`

### MODERATE — Unknown/null regime bucket mixed with real regimes
File: `src/services/analytics/aggregations/performance.ts:19-28`
What's wrong: `bucketByRegime` labels missing regime as `'unknown'` and then
computes performance stats for it. In downstream `convergence.ts:362-368`
the `unknown` bucket is explicitly excluded ("name !== 'unknown'"). Good.
But not every consumer excludes it: ad-hoc dashboard queries against
`regimeBreakdown.unknown` will compare incomparable populations (pre-regime-
classifier vs. recent trades). Document the convention.
Effort: one-line comment.

### MINOR — `profitFactor = 999` sentinel
File: `src/services/analytics/aggregations/base.ts:90-92`
What's wrong: `grossLosses === 0 && grossWins > 0 → 999` is a magic sentinel
for "no losses yet". Downstream the UI renders it. Prefer `Infinity` or
`null` with a comment.
Effort: one-line.

---

## `tilt/change-point.ts`

### MODERATE — `findEpisodeStart` walks back O(n) per trip, O(n²) worst case
File: `src/services/analytics/tilt/change-point.ts:259-264`
What's wrong: For each CUSUM trip the function walks the cusum array back to
the nearest zero. In the worst case (long monotone rise across the whole
history) this is O(n²). At scale (>10k trades) it matters; at current scale
(<1k) it doesn't. Cache the last-zero index during the forward CUSUM loop.
Effort: small change.

### MODERATE — `sorted.findIndex` in episode marking is O(n) per position
File: `src/services/analytics/tilt/change-point.ts:235-239`
What's wrong: For every position in every episode, `findIndex` scans
`sorted`. O(n × total_episode_positions). Build a `Map<id, index>` once
before the loop.
Effort: small change.

### MINOR — `z-score` fills nulls with 0, obscuring missing data
File: `src/services/analytics/tilt/change-point.ts:160-168`
What's wrong: When `vals.length < 2`, the function returns an all-zero
vector (line 162). The fallback flattens real data with missing data. At
the CUSUM consumer, both look identical (zero contribution). Differentiate
or return the same null the input had.
Effort: small change.

### COSMETIC — Verbose-mode `console.log` loop
File: `src/services/analytics/tilt/change-point.ts:201-207,240-246`
What's wrong: Heavy per-trade logging behind a `verbose` flag. Fine, but
consider a callback/debug interface instead of direct console for testability.
Effort: one-line.

---

## Cross-cutting issues

### Multiple-testing correction is applied globally but not within detectors
Several detectors pick the smaller of N p-values as their "primary" test
(revenge, disposition, overtrading, streak, size-escalation, sizing,
exit-optimizer, hold-time-optimizer). The global BH pass in statistics.ts
treats each of those test objects as an independent hypothesis — good — but
the *narrative text and severity gating* inside each detector is built
from the min-p selection before global correction, so the UI can claim
"significant difference detected" for patterns that wouldn't survive
correction. Two fixes together would solve this:
1. Remove local min-p selection; report each test on its own merits.
2. Gate narrative severity on the post-correction `isSignificant` flag
   (currently set after emission by the global pass). The detectors could
   consume the corrected flag by running in a two-pass pipeline.
Effort: moderate refactor across ~8 files.

### `r2`/`round` helpers duplicated in every file
Every metric and most insights redefine `round(v, digits)` locally. Hoist
to a shared utility. Not a bug; reduces the surface for drift.
Effort: small change.

### Inconsistent denominator convention (n vs n-1)
risk-metrics uses n-1 for standard dev and n for downside dev; walk-forward
uses n for both; sizing-analysis uses n-1. Pick one (Bessel-corrected sample
variance is the industry default for finite trader histories) and apply
everywhere.
Effort: small change.

### Production `console.log` calls
risk-metrics.ts:240, reconstructed.ts:134-144, combinatorial-search.ts:211,
change-point.ts:201-207 (verbose only). Behind a `DEBUG_ANALYTICS` flag.
Effort: small change.

---

## Summary table

| Severity  | Count |
| --------- | ----- |
| CRITICAL  | 8     |
| MODERATE  | 27    |
| MINOR     | 22    |
| COSMETIC  | 5     |

**Highest-ROI fixes** (big impact + small effort):
1. exit-optimizer.ts:93-98 — invert the projected-gain denominator *(one-line, CRITICAL)*
2. regime-mismatch.ts:210 — compute `isSignificant` from actual tests *(one-line, CRITICAL)*
3. aggregations/equity-curve.ts:46-98 and risk-metrics.ts:277-326 — thread
   startingCapital through drawdown math *(small change, CRITICAL × 2)*
4. xpnl.ts:188-208 — import shared `NUMERIC_FEATURE_NAMES` *(one-line, MODERATE)*
5. walk-forward / risk-metrics / sizing — unify Bessel convention *(small change)*

**Requires deeper work**:
- time-of-day-edge.ts fatigue split — data-snooping correction
- hold-time-optimizer.ts quartile bias — ANOVA/Kruskal-Wallis or Tukey HSD
- metrics/xpnl.ts KNN temporal leakage — walk-forward neighbor restriction
- Across detectors: remove local min-p selection; gate narratives on
  post-correction significance
