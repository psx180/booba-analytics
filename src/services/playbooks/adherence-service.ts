/**
 * adherence-service — turn a Position + Playbook into a score and a
 * per-rule breakdown.
 *
 * The service owns the data-plumbing that individual checkers shouldn't:
 *   • parsing the playbook JSON,
 *   • prefetching candles for any entry_near_ema rule,
 *   • counting same-day positions once for every max_daily_trades rule,
 *   • resolving account equity from whatever source the caller configures.
 *
 * Once the context bag is populated it iterates over the rule checkers and
 * collects RuleResults. The final score is passed / (passed + failed) * 100
 * — inconclusive rules are excluded from the denominator so the user isn't
 * penalised for rules the system couldn't evaluate.
 *
 * Persistence is separate: `runAndStoreAdherence` writes the score +
 * breakdown to the position and updates the playbook's rolling stats.
 * Callers that just want a preview (e.g. the "what would my score be?"
 * UI) can call `checkAdherence` alone.
 */

import type { Playbook, Position } from '../../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { getCandleCache } from '../candles';
import type { Candle } from '../regime/types';
import { ruleCheckers } from './rule-checkers';
import type { AdherenceResult, PlaybookRule, RuleCheckContext, RuleResult } from './types';

export interface AdherenceOptions {
  /** Passed to position_size. When absent the rule falls to inconclusive. */
  accountEquity?: number;
}

/**
 * Parse and enforce the rule JSON shape. Invalid rules (wrong shape, missing
 * fields) are dropped rather than throwing — a corrupted rule in storage
 * shouldn't brick the entire adherence check, and the service logs what it
 * skipped so the trader sees the rule disappear from their breakdown.
 */
function parseRules(rulesJson: string): PlaybookRule[] {
  try {
    const raw = JSON.parse(rulesJson);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is PlaybookRule =>
      r != null &&
      typeof r === 'object' &&
      typeof r.type === 'string' &&
      typeof r.params === 'object' &&
      typeof r.enabled === 'boolean',
    ).map((r) => ({
      type: r.type,
      params: r.params,
      enabled: r.enabled,
      label: typeof r.label === 'string' && r.label ? r.label : r.type,
    }));
  } catch {
    return [];
  }
}

/**
 * Decide which candles (if any) we need to satisfy every entry_near_ema
 * rule in the playbook. Picks the widest window across all EMA rules that
 * share a timeframe, so one fetch covers them all. Asset + entry time come
 * from the position.
 */
async function loadEmaCandles(
  position: Position,
  rules: PlaybookRule[],
): Promise<Candle[]> {
  const emaRules = rules.filter((r) => r.enabled && r.type === 'entry_near_ema');
  if (emaRules.length === 0 || !position.firstEntryTime) return [];

  // All EMA rules for this prototype use a single timeframe — the first one
  // wins. (Supporting multi-timeframe rules means one cache fetch per
  // distinct timeframe, a follow-up if the feature grows.)
  const first = emaRules[0].params as { period?: number; timeframe?: string };
  const timeframe = typeof first.timeframe === 'string' ? first.timeframe : '1h';
  const maxPeriod = Math.max(...emaRules.map((r) => Number((r.params as { period?: number }).period ?? 20)));

  const msPerCandle = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  }[timeframe] ?? 3_600_000;

  // Extra margin so the requested window actually contains `period` closed
  // candles even if the cache is missing a leading handful.
  const entryMs = position.firstEntryTime.getTime();
  const start = new Date(entryMs - msPerCandle * (maxPeriod + 5));
  const end = new Date(entryMs);

  try {
    return await getCandleCache().getCandles(position.asset, timeframe, start, end);
  } catch (err) {
    console.warn(`[adherence] candle fetch failed for ${position.asset} ${timeframe}:`, (err as Error).message);
    return [];
  }
}

/**
 * Count positions on the same UTC day as this one — shared across all
 * max_daily_trades rules in the playbook so we don't issue N queries for N
 * copies of the same rule type.
 */
async function loadDailyTradeCount(position: Position, rules: PlaybookRule[]): Promise<number | undefined> {
  const hasRule = rules.some((r) => r.enabled && r.type === 'max_daily_trades');
  if (!hasRule || !position.firstEntryTime || !position.walletAddress) return undefined;
  const dayStart = new Date(position.firstEntryTime);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return prisma.position.count({
    where: {
      walletAddress: position.walletAddress,
      firstEntryTime: { gte: dayStart, lt: dayEnd },
    },
  });
}

/**
 * Pure-ish: computes the score and returns the breakdown without touching
 * the database (beyond candle/count prefetch). Separate from the persist
 * wrapper so preview UIs can call it without mutating state.
 */
export async function checkAdherence(
  position: Position,
  playbook: Pick<Playbook, 'rules'>,
  options: AdherenceOptions = {},
): Promise<AdherenceResult> {
  const rules = parseRules(playbook.rules).filter((r) => r.enabled);
  if (rules.length === 0) {
    return { score: 0, passed: 0, failed: 0, inconclusive: 0, results: [] };
  }

  const [candles, dailyTradeCount] = await Promise.all([
    loadEmaCandles(position, rules),
    loadDailyTradeCount(position, rules),
  ]);

  const context: RuleCheckContext = {
    candles,
    dailyTradeCount,
    accountEquity: options.accountEquity,
  };

  const results: RuleResult[] = [];
  for (const rule of rules) {
    const checker = ruleCheckers.get(rule.type);
    if (!checker) {
      results.push({
        ruleType: rule.type,
        ruleLabel: rule.label,
        outcome: 'inconclusive',
        actual: `unknown rule type "${rule.type}"`,
        expected: '',
      });
      continue;
    }
    try {
      results.push(await checker(position, rule, context));
    } catch (err) {
      console.error(`[adherence] checker ${rule.type} failed:`, err);
      results.push({
        ruleType: rule.type,
        ruleLabel: rule.label,
        outcome: 'inconclusive',
        actual: `checker error: ${(err as Error).message}`,
        expected: '',
      });
    }
  }

  const passed = results.filter((r) => r.outcome === 'passed').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const inconclusive = results.filter((r) => r.outcome === 'inconclusive').length;
  const denom = passed + failed;
  const score = denom === 0 ? 0 : Math.round((passed / denom) * 1000) / 10;

  return { score, passed, failed, inconclusive, results };
}

/**
 * Run adherence against whichever playbook the position is tagged with,
 * persist the score + breakdown on the position, and update the playbook's
 * rolling average. No-ops when the position has no playbook.
 *
 * Returns the computed result so callers (API endpoints, fill-handler) can
 * surface it without re-reading the row.
 */
export async function runAndStoreAdherence(
  positionId: string,
  options: AdherenceOptions = {},
): Promise<AdherenceResult | null> {
  const position = await prisma.position.findUnique({ where: { id: positionId } });
  if (!position || !position.playbookId) return null;

  const playbook = await prisma.playbook.findUnique({ where: { id: position.playbookId } });
  if (!playbook) return null;

  const result = await checkAdherence(position, playbook, options);

  await prisma.position.update({
    where: { id: positionId },
    data: {
      adherenceScore: result.score,
      adherenceDetail: JSON.stringify(result.results),
    },
  });

  // Refresh the playbook's rolling stats from everyone tagged with it. This
  // is O(N positions on playbook) — cheap at our scale and avoids the
  // running-average drift that an incremental update would suffer if a
  // position got re-checked with new rule results.
  const tagged = await prisma.position.findMany({
    where: { playbookId: playbook.id, adherenceScore: { not: null } },
    select: { adherenceScore: true },
  });
  const total = tagged.length;
  const avg =
    total === 0
      ? null
      : tagged.reduce((s, p) => s + (p.adherenceScore ?? 0), 0) / total;
  await prisma.playbook.update({
    where: { id: playbook.id },
    data: {
      totalChecks: total,
      avgAdherence: avg != null ? Math.round(avg * 10) / 10 : null,
    },
  });

  return result;
}
