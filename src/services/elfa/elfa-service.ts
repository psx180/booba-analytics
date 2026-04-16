/**
 * ELFA AI social intelligence service.
 *
 * Provides social context for crypto tokens using the ELFA AI API.
 * All calls are wrapped in try-catch — ELFA data is enrichment, not critical.
 * Results are cached in memory for 5 minutes to avoid API rate limits.
 *
 * API base: https://api.elfa.ai
 * Auth: x-elfa-api-key header (ELFA_API_KEY env var)
 */

export interface ElfaSocialContext {
  sentimentScore: number;    // -1 to 1
  mentionCount: number;      // mentions in the time window
  mindshare: number;         // % of total crypto discussion
  topMention: string | null; // most significant mention summary
  trendDirection: string;    // 'rising' | 'falling' | 'stable'
}

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const BASE_URL = 'https://api.elfa.ai';
const REQUEST_TIMEOUT_MS = 5_000;

const _cache = new Map<string, CacheEntry>();

// Once the top-mentions endpoint returns 404, skip all further calls this session
// to avoid log spam. A 404 means the endpoint is unavailable (e.g. on testnet).
let _topMentionsUnavailable = false;

function getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCached(key: string, data: unknown): void {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function apiHeaders(): Record<string, string> {
  return { 'x-elfa-api-key': process.env.ELFA_API_KEY ?? '' };
}

async function elfaFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: apiHeaders(), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type TrendingEntry = { token: string; mentions: number; change: number };
type RawRecord = Record<string, unknown>;

/** Fetch raw trending tokens for a time window. Cached per window. */
async function fetchTrendingRaw(timeWindow: string): Promise<TrendingEntry[]> {
  const cacheKey = `trending:${timeWindow}`;
  const cached = getCached<TrendingEntry[]>(cacheKey);
  if (cached) return cached;

  const res = await elfaFetch(
    `${BASE_URL}/v2/aggregations/trending-tokens?timeWindow=${timeWindow}&pageSize=20`,
  );
  if (!res.ok) throw new Error(`trending-tokens HTTP ${res.status}`);

  const json = await res.json() as unknown;
  const items: RawRecord[] = Array.isArray(json)
    ? (json as RawRecord[])
    : ((json as RawRecord).data as RawRecord[] ?? []);

  const tokens: TrendingEntry[] = items.map((t) => ({
    token: String(t.ticker ?? t.token ?? ''),
    mentions: Number(t.mentionCount ?? t.mentions ?? 0),
    change: Number(t.percentageChange ?? t.change ?? 0),
  }));

  setCached(cacheKey, tokens);
  return tokens;
}

/**
 * Get social context for a token at the time of query.
 * Returns null if the API is unavailable, rate-limited, or token not found.
 */
export async function getTokenSocialContext(
  asset: string,
  timeWindow = '1h',
): Promise<ElfaSocialContext | null> {
  if (_topMentionsUnavailable) return null;

  const cacheKey = `context:${asset}:${timeWindow}`;
  const cached = getCached<ElfaSocialContext>(cacheKey);
  if (cached) return cached;

  try {
    const [mentionsRes, trendingTokens] = await Promise.all([
      elfaFetch(
        `${BASE_URL}/v2/aggregations/top-mentions?ticker=$${asset}&timeWindow=${timeWindow}`,
      ),
      fetchTrendingRaw(timeWindow).catch(() => [] as TrendingEntry[]),
    ]);

    if (!mentionsRes.ok) {
      if (mentionsRes.status === 404) {
        _topMentionsUnavailable = true;
        console.warn('[elfa] top-mentions endpoint not available (404) — skipping ELFA enrichment for this session');
        return null;
      }
      throw new Error(`top-mentions HTTP ${mentionsRes.status}`);
    }

    const mentionsJson = await mentionsRes.json() as unknown;
    const items: RawRecord[] = Array.isArray(mentionsJson)
      ? (mentionsJson as RawRecord[])
      : ((mentionsJson as RawRecord).data as RawRecord[] ?? []);

    const mentionCount =
      items.length > 0
        ? Number(items[0].mentionCount ?? items[0].count ?? items.length)
        : 0;

    // Average available sentiment scores across all mentions
    const withSentiment = items.filter(
      (m) => m.sentimentScore != null || m.sentiment != null,
    );
    const rawSentiment =
      withSentiment.length > 0
        ? withSentiment.reduce(
            (s, m) => s + Number(m.sentimentScore ?? m.sentiment ?? 0),
            0,
          ) / withSentiment.length
        : 0;
    const sentimentScore = Math.max(-1, Math.min(1, rawSentiment));

    // Find asset in trending list for mindshare and trend direction
    const assetLower = asset.toLowerCase();
    const trendingEntry = trendingTokens.find(
      (t) =>
        t.token.replace('$', '').toLowerCase() === assetLower ||
        t.token.toLowerCase() === assetLower,
    );
    const totalMentions = trendingTokens.reduce((s, t) => s + t.mentions, 0);
    const mindshare =
      trendingEntry && totalMentions > 0
        ? Math.round((trendingEntry.mentions / totalMentions) * 1_000) / 10
        : 0;

    const trendDirection: string = trendingEntry
      ? trendingEntry.change > 10
        ? 'rising'
        : trendingEntry.change < -10
          ? 'falling'
          : 'stable'
      : 'stable';

    const topMentionRaw =
      items.length > 0
        ? String(items[0].title ?? items[0].text ?? items[0].content ?? '')
        : '';
    const topMention = topMentionRaw || null;

    const context: ElfaSocialContext = {
      sentimentScore,
      mentionCount,
      mindshare,
      topMention,
      trendDirection,
    };

    setCached(cacheKey, context);
    return context;
  } catch (err) {
    console.warn('[elfa] API error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Get top 20 trending tokens.
 * Returns empty array if the API is unavailable.
 */
export async function getTrendingTokens(
  timeWindow = '1h',
): Promise<TrendingEntry[]> {
  try {
    return await fetchTrendingRaw(timeWindow);
  } catch (err) {
    console.warn('[elfa] API error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
