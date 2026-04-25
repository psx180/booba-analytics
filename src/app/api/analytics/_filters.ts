/**
 * Shared filter parsing for analytics API routes.
 * Pulls standard filter params out of a URLSearchParams and returns a
 * Filters object that the analytics service understands.
 *
 * Note: parseFilters does *not* set `journalId` — that's a separate async
 * step (resolveJournalId) because it may need to look up the wallet's
 * default journal. Routes typically:
 *
 *   const filters = parseFilters(sp);
 *   filters.journalId = await resolveJournalId(walletAddress, sp.get('journalId'));
 */

import type { Filters } from '@/services/analytics';

export function parseFilters(sp: URLSearchParams): Filters {
  const filters: Filters = {};

  const regime = sp.get('regime');
  if (regime) filters.regime = regime;

  const asset = sp.get('asset');
  if (asset) filters.asset = asset;

  const strategy = sp.get('strategy');
  if (strategy) filters.strategy = strategy;

  const source = sp.get('source');
  if (source) filters.source = source;

  const tradeType = sp.get('tradeType');
  if (tradeType) filters.tradeType = tradeType;

  const builderCode = sp.get('builderCode');
  if (builderCode) filters.builderCode = builderCode;
  if (sp.get('builderCodeExclude') === 'true') filters.builderCodeExclude = true;
  if (sp.get('manualOnly') === 'true') filters.manualOnly = true;
  // CSV in the query string keeps it readable in URLs and avoids the
  // `?excludeBuilderCodes=a&excludeBuilderCodes=b` repeat-key idiom that
  // browsers don't always preserve.
  const excludeRaw = sp.get('excludeBuilderCodes');
  if (excludeRaw) {
    const codes = excludeRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length > 0) filters.excludeBuilderCodes = codes;
  }

  const dateFrom = sp.get('dateFrom');
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (isFinite(d.getTime())) filters.dateFrom = d;
  }

  const dateTo = sp.get('dateTo');
  if (dateTo) {
    const d = new Date(dateTo);
    if (isFinite(d.getTime())) filters.dateTo = d;
  }

  return filters;
}