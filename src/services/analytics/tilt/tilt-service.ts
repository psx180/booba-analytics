/**
 * TiltService — orchestrates a TiltDetector and persists its output.
 *
 * The service is deliberately thin: it loads positions chronologically,
 * delegates to the configured detector, writes the per-position score +
 * episode id + feature snapshot back to the Position table, and exposes a
 * pair of read helpers for downstream callers.
 *
 * Swapping detectors means passing a different TiltDetector into the
 * constructor — nothing in the persistence code changes.
 */

import type { PrismaClient } from '../../../../generated/prisma/client';
import type { Position } from '../types';
import type { TiltDetector, TiltScore, TiltEpisode } from './types';

export interface TiltAnalyzeSummary {
  scores         : TiltScore[];
  episodes       : TiltEpisode[];
  summary: {
    totalEpisodes    : number;
    positionsAffected: number;
  };
}

export class TiltService {
  constructor(
    private readonly detector: TiltDetector,
    private readonly db      : PrismaClient,
  ) {}

  /**
   * Run detection over every position for this wallet and persist
   * tiltScore / tiltEpisodeId / tiltFeatures back to each record.
   */
  async analyzeAndPersist(walletAddress: string): Promise<TiltAnalyzeSummary> {
    const positions = await this.db.position.findMany({
      where  : { walletAddress },
      orderBy: { firstEntryTime: 'asc' },
    });

    console.log(
      `[tilt] ${this.detector.name}: analysing ${positions.length} positions for ${walletAddress}`,
    );

    if (positions.length === 0) {
      return { scores: [], episodes: [], summary: { totalEpisodes: 0, positionsAffected: 0 } };
    }

    const { scores, episodes } = this.detector.detect(positions as unknown as Position[]);

    // Persist per position. Every position gets its score written, even
    // when it's low or zero — that way "null" unambiguously means "not
    // yet computed" and downstream detectors can rely on it.
    for (const s of scores) {
      await this.db.position.update({
        where: { id: s.positionId },
        data : {
          tiltScore    : s.score,
          tiltEpisodeId: s.episodeId,
          tiltFeatures : JSON.stringify(s.features),
        },
      });
    }

    const positionsAffected = new Set(episodes.flatMap((e) => e.positionIds)).size;

    console.log(
      `[tilt] ${this.detector.name}: wrote ${scores.length} scores, ` +
      `${episodes.length} episodes, ${positionsAffected} positions affected`,
    );
    for (const ep of episodes) {
      console.log(
        `[tilt] episode ${ep.id}: ${ep.startTime.toISOString()} → ` +
        `${ep.endTime?.toISOString() ?? 'open'} N=${ep.positionIds.length} ` +
        `severity=${ep.severity.toFixed(2)} trigger=${ep.trigger} ` +
        `pnlDuring=${ep.pnlDuringEpisode.toFixed(2)}`,
      );
    }

    return {
      scores,
      episodes,
      summary: { totalEpisodes: episodes.length, positionsAffected },
    };
  }

  /** Read a single precomputed tilt score directly from the DB. */
  async getScore(positionId: string): Promise<number | null> {
    const row = await this.db.position.findUnique({
      where : { id: positionId },
      select: { tiltScore: true },
    });
    return row?.tiltScore ?? null;
  }

  /**
   * Reconstruct tilt episodes for a wallet by grouping positions on
   * tiltEpisodeId. Ordering within each episode is chronological.
   */
  async getEpisodes(walletAddress: string): Promise<TiltEpisode[]> {
    const rows = await this.db.position.findMany({
      where  : { walletAddress, tiltEpisodeId: { not: null } },
      orderBy: { firstEntryTime: 'asc' },
    });

    const byEpisode = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.tiltEpisodeId!;
      if (!byEpisode.has(key)) byEpisode.set(key, []);
      byEpisode.get(key)!.push(r);
    }

    // For the "outside" P&L comparison, load all positions once.
    const all      = await this.db.position.findMany({ where: { walletAddress } });
    const inAnyEp  = new Set(rows.map((r) => r.id));
    const outsideP = all.filter((p) => !inAnyEp.has(p.id))
                         .reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);

    const episodes: TiltEpisode[] = [];
    for (const [episodeId, members] of byEpisode) {
      if (members.length === 0) continue;
      const pnlDuring = members.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
      const peakScore = Math.max(...members.map((p) => p.tiltScore ?? 0));

      // Trigger: if stored in features, use it; otherwise reconstruct from prefix.
      // We don't store the trigger alongside the position — it's an
      // episode-level attribute — so keep it simple here and label it
      // 'behavioral_shift'. Detectors that need the original trigger call
      // analyzeAndPersist and read from the returned TiltDetectionResult.
      episodes.push({
        id               : episodeId,
        startTime        : members[0].firstEntryTime ?? new Date(0),
        endTime          : members[members.length - 1].lastExitTime ?? null,
        trigger          : 'behavioral_shift',
        positionIds      : members.map((p) => p.id),
        severity         : peakScore,
        pnlDuringEpisode : pnlDuring,
        pnlOutsideEpisodes: outsideP,
      });
    }

    return episodes;
  }
}
