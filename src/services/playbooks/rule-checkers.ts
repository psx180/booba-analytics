/**
 * rule-checkers — one pure function per rule type, registered in a Map.
 *
 * Each checker receives the position, the rule (with params + label) and
 * an optional context bag that the adherence service prefetches (candles,
 * account equity, daily trade count). Checkers never throw — when data is
 * missing they return an `inconclusive` result so the score denominator
 * skips the rule but the UI still surfaces what couldn't be evaluated.
 *
 * Adding a new rule type = write a new function, register it with
 * `ruleCheckers.set('my_rule', myChecker)`. The adherence service, API,
 * and UI don't change — they iterate over whatever's in the registry.
 */

import type { Position } from '../../../generated/prisma/client';
import type { PlaybookRule, RuleCheckContext, RuleResult } from './types';
import type { Candle } from '../regime/types';

export type RuleChecker = (
  position: Position,
  rule: PlaybookRule,
  context: RuleCheckContext,
) => RuleResult | Promise<RuleResult>;

export const ruleCheckers: Map<string, RuleChecker> = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function inconclusive(rule: PlaybookRule, reason: string): RuleResult {
  return {
    ruleType: rule.type,
    ruleLabel: rule.label,
    outcome: 'inconclusive',
    actual: reason,
    expected: describeExpected(rule),
  };
}

function pass(rule: PlaybookRule, actual: string, expected: string): RuleResult {
  return { ruleType: rule.type, ruleLabel: rule.label, outcome: 'passed', actual, expected };
}

function fail(rule: PlaybookRule, actual: string, expected: string): RuleResult {
  return { ruleType: rule.type, ruleLabel: rule.label, outcome: 'failed', actual, expected };
}

/**
 * Human-readable one-liner for the `expected` side of a rule — used in the
 * UI breakdown so the trader sees "max 3%" / "LONG" / "Trending, Trending HV"
 * next to the actual value the position carried. Kept here (not on the
 * rule itself) so the labels stay consistent across checkers.
 */
function describeExpected(rule: PlaybookRule): string {
  const p = rule.params as Record<string, unknown>;
  switch (rule.type) {
    case 'direction':        return String(p.direction ?? '');
    case 'asset':            return Array.isArray(p.assets) ? (p.assets as string[]).join(', ') : '';
    case 'regime':           return Array.isArray(p.regimes) ? (p.regimes as string[]).join(', ') : '';
    case 'time_of_day':      return `${p.startHour}:00–${p.endHour}:00 UTC`;
    case 'max_daily_trades': return `≤ ${p.maxTrades} per day`;
    case 'stop_distance':    return `≤ ${p.maxPercent}%`;
    case 'position_size':    return `≤ ${p.maxPercentOfEquity}% of equity`;
    case 'min_risk_reward':  return `≥ ${p.minRR}:1`;
    case 'entry_near_ema':   return `within ${p.maxDistancePercent}% of EMA${p.period} (${p.timeframe})`;
    default:                 return '';
  }
}

/**
 * Classic EMA: first value seeds with close[0], then each subsequent close
 * is weighted by k = 2 / (period + 1). Returns the EMA of the final candle
 * in the input. Caller is responsible for supplying at least `period`
 * candles ending at (or just before) the entry timestamp — with fewer, the
 * result is still defined but statistically meaningless.
 */
export function computeEMA(closes: number[], period: number): number {
  if (closes.length === 0) throw new Error('computeEMA: empty input');
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Checkers ────────────────────────────────────────────────────────────────

/**
 * Direction: position.direction ('long'/'short') vs params.direction
 * ('LONG'/'SHORT'). Compared case-insensitively so rule authors can write
 * either form.
 */
function checkDirection(position: Position, rule: PlaybookRule): RuleResult {
  const expected = String((rule.params as { direction?: string }).direction ?? '').toLowerCase();
  const actual = (position.direction ?? '').toLowerCase();
  if (!expected) return inconclusive(rule, 'rule misconfigured');
  return actual === expected
    ? pass(rule, actual.toUpperCase(), expected.toUpperCase())
    : fail(rule, actual.toUpperCase(), expected.toUpperCase());
}
ruleCheckers.set('direction', checkDirection);

function checkAsset(position: Position, rule: PlaybookRule): RuleResult {
  const assets = (rule.params as { assets?: string[] }).assets ?? [];
  const actual = position.asset;
  const expected = assets.join(', ');
  if (assets.length === 0) return inconclusive(rule, 'no assets configured');
  return assets.includes(actual) ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('asset', checkAsset);

/**
 * Regime: position.regimeAtEntry uses internal form ('trending_low_vol');
 * params.regimes should use the same form. Inconclusive when the position
 * was never regime-tagged (e.g. regime detector hasn't run for this asset).
 */
function checkRegime(position: Position, rule: PlaybookRule): RuleResult {
  const regimes = (rule.params as { regimes?: string[] }).regimes ?? [];
  const actual = position.regimeAtEntry;
  const expected = regimes.join(', ');
  if (regimes.length === 0) return inconclusive(rule, 'no regimes configured');
  if (!actual) return inconclusive(rule, 'no regime tagged');
  return regimes.includes(actual) ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('regime', checkRegime);

/**
 * Time-of-day: checks entry hour against a half-open [startHour, endHour)
 * window in UTC. Handles wrap-around (e.g. 22→4 for overnight sessions) so
 * the US evening / Asian session can be expressed naturally.
 */
function checkTimeOfDay(position: Position, rule: PlaybookRule): RuleResult {
  const { startHour, endHour } = rule.params as { startHour?: number; endHour?: number };
  if (startHour == null || endHour == null) return inconclusive(rule, 'rule misconfigured');
  if (!position.firstEntryTime) return inconclusive(rule, 'no entry time');
  const hour = position.firstEntryTime.getUTCHours();
  const inWindow =
    startHour <= endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour;
  const actual = `${String(hour).padStart(2, '0')}:00 UTC`;
  const expected = `${String(startHour).padStart(2, '0')}:00–${String(endHour).padStart(2, '0')}:00 UTC`;
  return inWindow ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('time_of_day', checkTimeOfDay);

/**
 * Max daily trades: counts positions opened on the same UTC calendar day
 * as this one (inclusive of the position itself). Prefers the count in
 * context when the adherence service has already loaded the wallet's
 * positions for the day — falls back to a targeted DB query otherwise.
 */
async function checkMaxDailyTrades(
  position: Position,
  rule: PlaybookRule,
  context: RuleCheckContext,
): Promise<RuleResult> {
  const max = Number((rule.params as { maxTrades?: number }).maxTrades ?? NaN);
  if (!Number.isFinite(max)) return inconclusive(rule, 'rule misconfigured');
  if (!position.firstEntryTime) return inconclusive(rule, 'no entry time');

  let count = context.dailyTradeCount;
  if (count == null) {
    const { prisma } = await import('../../lib/prisma');
    const dayStart = new Date(position.firstEntryTime);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    count = await prisma.position.count({
      where: {
        walletAddress: position.walletAddress ?? undefined,
        firstEntryTime: { gte: dayStart, lt: dayEnd },
      },
    });
  }

  const actual = `${count} on ${position.firstEntryTime.toISOString().slice(0, 10)}`;
  const expected = `≤ ${max} per day`;
  return count <= max ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('max_daily_trades', checkMaxDailyTrades);

/**
 * Stop distance: how far from entry did the declared stop sit? Prefer the
 * user's own invalidationPrice (what they planned); fall back to maePrice
 * (what the trade actually drew down to) when no plan was recorded.
 * Inconclusive when neither exists.
 */
function checkStopDistance(position: Position, rule: PlaybookRule): RuleResult {
  const max = Number((rule.params as { maxPercent?: number }).maxPercent ?? NaN);
  if (!Number.isFinite(max)) return inconclusive(rule, 'rule misconfigured');
  const entry = position.averageEntryPrice;
  if (!entry) return inconclusive(rule, 'no entry price');

  const reference = position.invalidationPrice ?? position.maePrice;
  if (reference == null) return inconclusive(rule, 'no stop or MAE data');

  const distancePct = Math.abs(entry - reference) / entry * 100;
  const actual = `${distancePct.toFixed(2)}%${position.invalidationPrice != null ? ' (planned)' : ' (MAE)'}`;
  const expected = `≤ ${max}%`;
  return distancePct <= max ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('stop_distance', checkStopDistance);

/**
 * Position size as % of account equity at entry. Requires `accountEquity`
 * in context (the adherence service pulls it from whatever source the
 * caller configures — Pacifica account state, user setting, or a seeded
 * default for historical data). Inconclusive when equity isn't supplied.
 */
function checkPositionSize(
  position: Position,
  rule: PlaybookRule,
  context: RuleCheckContext,
): RuleResult {
  const max = Number((rule.params as { maxPercentOfEquity?: number }).maxPercentOfEquity ?? NaN);
  if (!Number.isFinite(max)) return inconclusive(rule, 'rule misconfigured');
  if (!context.accountEquity || context.accountEquity <= 0) {
    return inconclusive(rule, 'no account equity');
  }
  if (position.totalSize == null || position.averageEntryPrice == null) {
    return inconclusive(rule, 'incomplete position data');
  }
  const notional = Math.abs(position.totalSize) * position.averageEntryPrice;
  const pct = notional / context.accountEquity * 100;
  const actual = `${pct.toFixed(2)}%`;
  const expected = `≤ ${max}%`;
  return pct <= max ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('position_size', checkPositionSize);

/**
 * Min planned risk:reward — requires both an invalidation price (stop) and
 * at least one target price. Picks the nearest target from the JSON array
 * so the user can't satisfy the rule by only hitting a moonshot. RR = target
 * distance / stop distance, both measured from the entry price.
 */
function checkMinRiskReward(position: Position, rule: PlaybookRule): RuleResult {
  const min = Number((rule.params as { minRR?: number }).minRR ?? NaN);
  if (!Number.isFinite(min)) return inconclusive(rule, 'rule misconfigured');
  const entry = position.averageEntryPrice;
  const stop = position.invalidationPrice;
  if (!entry || stop == null) return inconclusive(rule, 'no stop/target set');

  let targets: number[] = [];
  if (position.targetPrice) {
    try {
      const parsed = JSON.parse(position.targetPrice);
      targets = Array.isArray(parsed)
        ? parsed.map(Number).filter((n) => Number.isFinite(n))
        : [Number(parsed)].filter((n) => Number.isFinite(n));
    } catch {
      const asNum = Number(position.targetPrice);
      if (Number.isFinite(asNum)) targets = [asNum];
    }
  }
  if (targets.length === 0) return inconclusive(rule, 'no target set');

  const stopDist = Math.abs(entry - stop);
  if (stopDist === 0) return inconclusive(rule, 'stop equals entry');

  // Nearest target — the RR you were actually first prepared to accept.
  const nearest = targets.reduce((best, t) =>
    Math.abs(t - entry) < Math.abs(best - entry) ? t : best, targets[0]);
  const rr = Math.abs(nearest - entry) / stopDist;
  const actual = `${rr.toFixed(2)}:1`;
  const expected = `≥ ${min}:1`;
  return rr >= min ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('min_risk_reward', checkMinRiskReward);

/**
 * Entry-near-EMA: take the `period` most recent closed candles at or
 * before the entry timestamp, compute the EMA, check that the entry price
 * sits within maxDistancePercent of it. Expects the adherence service to
 * have prefetched candles into context.candles — the checker itself never
 * hits the cache, keeping the hot path synchronous when a playbook has
 * many EMA rules across different periods.
 */
function checkEntryNearEma(
  position: Position,
  rule: PlaybookRule,
  context: RuleCheckContext,
): RuleResult {
  const period = Number((rule.params as { period?: number }).period ?? NaN);
  const maxDistPct = Number((rule.params as { maxDistancePercent?: number }).maxDistancePercent ?? NaN);
  if (!Number.isFinite(period) || !Number.isFinite(maxDistPct)) {
    return inconclusive(rule, 'rule misconfigured');
  }
  if (!position.averageEntryPrice || !position.firstEntryTime) {
    return inconclusive(rule, 'no entry data');
  }

  const candles = context.candles ?? [];
  const entryMs = position.firstEntryTime.getTime();
  const usable: Candle[] = candles.filter((c) => c.timestamp.getTime() <= entryMs);
  if (usable.length < period) return inconclusive(rule, 'not enough candles');

  const window = usable.slice(-period);
  const ema = computeEMA(window.map((c) => c.close), period);
  if (ema <= 0) return inconclusive(rule, 'invalid ema');

  const distPct = Math.abs(position.averageEntryPrice - ema) / ema * 100;
  const actual = `${distPct.toFixed(2)}% from EMA${period}`;
  const expected = `≤ ${maxDistPct}%`;
  return distPct <= maxDistPct ? pass(rule, actual, expected) : fail(rule, actual, expected);
}
ruleCheckers.set('entry_near_ema', checkEntryNearEma);

// ── Public catalog (for UI dropdowns and validation) ───────────────────────
// Defined in a separate Prisma-free file so client components can import it.
export type { RuleTypeDescriptor } from './rule-type-descriptors';
export { RULE_TYPES } from './rule-type-descriptors';
