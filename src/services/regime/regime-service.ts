import { prisma } from '../../lib/prisma';
import type { CandleSource, RegimeDetector, RegimeReading } from './types';

export class RegimeService {
  constructor(
    private detector: RegimeDetector,
    private candleSource: CandleSource,
  ) {}

  /**
   * Fetch candles for the given range, run the detector, store results.
   *
   * Fetches `requiredCandles` extra candles before `start` so the detector
   * has enough warmup history. The warmup candles are used for computation
   * but their readings are not stored (they fall before the requested range).
   *
   * Idempotent: existing snapshots for the same asset/timestamp/timeframe/method
   * are skipped via the unique constraint.
   */
  async computeRegimes(
    asset: string,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<{ computed: number; skipped: number }> {
    // Estimate warmup window based on timeframe (daily = 1 day per candle, etc.)
    const msPerCandle = timeframeToMs(timeframe);
    const warmupMs = this.detector.requiredCandles * msPerCandle;
    const warmupStart = new Date(start.getTime() - warmupMs);

    const candles = await this.candleSource.fetchCandles(asset, timeframe, warmupStart, end);
    const readings = this.detector.detect(candles);

    // Only store readings that fall within the requested range
    const inRange = readings.filter(
      (r) => r.timestamp >= start && r.timestamp <= end,
    );

    let computed = 0;
    let skipped = 0;

    for (const reading of inRange) {
      try {
        await prisma.regimeSnapshot.upsert({
          where: {
            asset_timestamp_timeframe_method: {
              asset,
              timestamp: reading.timestamp,
              timeframe,
              method: this.detector.name,
            },
          },
          create: {
            asset,
            timestamp: reading.timestamp,
            timeframe,
            method: this.detector.name,
            regimeClassification: reading.classification,
            confidence: reading.confidence,
            adxValue: reading.indicators.adx ?? null,
            atrValue: reading.indicators.atr ?? null,
            atrSmaValue: reading.indicators.atr_sma ?? null,
          },
          update: {
            regimeClassification: reading.classification,
            confidence: reading.confidence,
            adxValue: reading.indicators.adx ?? null,
            atrValue: reading.indicators.atr ?? null,
            atrSmaValue: reading.indicators.atr_sma ?? null,
          },
        });
        computed++;
      } catch {
        skipped++;
      }
    }

    return { computed, skipped };
  }

  /**
   * Tag all trades that have no regime_at_entry set.
   *
   * For each trade, finds the regime snapshot closest to (but not after)
   * the trade's entry time — i.e. the regime that was in effect when the
   * trader entered the position.
   *
   * Returns the number of trades tagged.
   */
  async tagTrades(): Promise<number> {
    // Diagnostic: how many snapshots exist and under which assets?
    const snapshotAssets = await prisma.regimeSnapshot.groupBy({
      by: ['asset'],
      _count: { _all: true },
    });
    const totalSnapshots = snapshotAssets.reduce((sum, row) => sum + row._count._all, 0);
    console.log(
      '[regime-service.tagTrades] snapshots:',
      totalSnapshots,
      'by asset:',
      snapshotAssets.map((r) => `${r.asset}=${r._count._all}`).join(', '),
    );

    // Diagnostic: how many trades exist, and how many are already tagged?
    const totalTrades = await prisma.trade.count();
    const taggedCount = await prisma.trade.count({ where: { NOT: { regimeAtEntry: null } } });
    const untaggedCount = await prisma.trade.count({ where: { regimeAtEntry: null } });
    console.log(
      '[regime-service.tagTrades] trades total:',
      totalTrades,
      'regimeAtEntry non-null:',
      taggedCount,
      'null:',
      untaggedCount,
    );

    const untagged = await prisma.trade.findMany({
      where: { regimeAtEntry: null },
      select: { id: true, asset: true, entryTime: true },
    });

    // Diagnostic: what assets do the untagged trades have? The matching logic
    // below looks up RegimeSnapshot by method + timestamp only — asset is NOT
    // part of the where clause. So mismatches like snapshots under 'BTCUSDT'
    // vs trades under 'BTC' will not cause lookup failures here, but it's
    // useful to see the asset distribution regardless.
    const untaggedAssets = new Map<string, number>();
    for (const t of untagged) {
      untaggedAssets.set(t.asset, (untaggedAssets.get(t.asset) ?? 0) + 1);
    }
    console.log(
      '[regime-service.tagTrades] untagged trade assets:',
      Array.from(untaggedAssets.entries()).map(([a, n]) => `${a}=${n}`).join(', '),
      '| matching by method:',
      this.detector.name,
    );

    let tagged = 0;
    let skippedNoEntry = 0;
    let skippedNoSnapshot = 0;
    let errored = 0;

    for (const trade of untagged) {
      try {
        if (!trade.entryTime || trade.entryTime.getTime() === 0) {
          skippedNoEntry++;
          continue;
        }

        // Find the most recent snapshot at or before entry time
        const snapshot = await prisma.regimeSnapshot.findFirst({
          where: {
            timestamp: { lte: trade.entryTime },
            method: this.detector.name,
          },
          orderBy: { timestamp: 'desc' },
        });

        if (!snapshot?.regimeClassification) {
          skippedNoSnapshot++;
          continue;
        }

        await prisma.trade.update({
          where: { id: trade.id },
          data: {
            regimeAtEntry: snapshot.regimeClassification,
            updatedAt: new Date(),
          },
        });
        tagged++;
      } catch {
        errored++;
        // Non-standard asset or unexpected value type — skip this trade
      }
    }

    console.log(
      '[regime-service.tagTrades] done — updated:',
      tagged,
      'skipped (no entryTime):',
      skippedNoEntry,
      'skipped (no snapshot):',
      skippedNoSnapshot,
      'errored:',
      errored,
    );

    return tagged;
  }

  /**
   * Get the regime in effect at a specific moment.
   * Used for real-time tagging when a new trade is detected.
   */
  async getRegimeAt(asset: string, timestamp: Date): Promise<RegimeReading | null> {
    try {
      const snapshot = await prisma.regimeSnapshot.findFirst({
        where: {
          asset,
          timestamp: { lte: timestamp },
          method: this.detector.name,
        },
        orderBy: { timestamp: 'desc' },
      });

      if (!snapshot?.regimeClassification) return null;

      return {
        timestamp: snapshot.timestamp,
        classification: snapshot.regimeClassification as RegimeReading['classification'],
        confidence: snapshot.confidence ?? 0,
        indicators: {
          adx: snapshot.adxValue ?? 0,
          atr: snapshot.atrValue ?? 0,
          atr_sma: snapshot.atrSmaValue ?? 0,
        },
      };
    } catch {
      return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeframeToMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m':  60_000,
    '3m':  3 * 60_000,
    '5m':  5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h':  3_600_000,
    '2h':  2 * 3_600_000,
    '4h':  4 * 3_600_000,
    '8h':  8 * 3_600_000,
    '12h': 12 * 3_600_000,
    '1d':  86_400_000,
  };
  return map[timeframe] ?? 86_400_000;
}
