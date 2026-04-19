import type { EquityPoint, DrawdownSummary } from './types';

export function computeDrawdownSummary(series: EquityPoint[]): DrawdownSummary {
  if (series.length === 0) {
    return {
      maxDrawdownPct: 0,
      maxDrawdownDollars: 0,
      maxDrawdownStart: null,
      maxDrawdownEnd: null,
      currentDrawdownPct: 0,
      currentDrawdownDollars: 0,
      avgRecoveryTrades: 0,
      drawdownEpisodesOver5Pct: 0,
      maxDrawdownDuration: 0,
      timeUnderwaterPct: 0,
    };
  }

  let maxDD = 0;
  let maxDDPct = 0;
  let maxDDStart: Date | null = null;
  let maxDDEnd: Date | null = null;
  let currentRunLen = 0;
  let maxRunLen = 0;
  let episodeStart: Date | null = null;
  let underwaterCount = 0;
  const recoveryLengths: number[] = [];
  let currentEpisodeLen = 0;

  for (const pt of series) {
    if (pt.underwaterDollars < 0) {
      underwaterCount++;
      currentRunLen++;
      currentEpisodeLen++;
      if (!episodeStart) episodeStart = pt.timestamp;
      if (currentRunLen > maxRunLen) maxRunLen = currentRunLen;
      if (pt.underwaterDollars < maxDD) {
        maxDD = pt.underwaterDollars;
        maxDDPct = pt.underwaterPct;
        maxDDEnd = pt.timestamp;
        maxDDStart = episodeStart;
      }
    } else {
      if (currentEpisodeLen > 0) recoveryLengths.push(currentEpisodeLen);
      currentRunLen = 0;
      currentEpisodeLen = 0;
      episodeStart = null;
    }
  }

  let inEpisode = false;
  let episodeMinPct = 0;
  let episodesOver5 = 0;
  for (const pt of series) {
    if (pt.underwaterPct < 0) {
      if (!inEpisode) {
        inEpisode = true;
        episodeMinPct = 0;
      }
      if (pt.underwaterPct < episodeMinPct) episodeMinPct = pt.underwaterPct;
    } else {
      if (inEpisode && episodeMinPct < -5) episodesOver5++;
      inEpisode = false;
      episodeMinPct = 0;
    }
  }
  if (inEpisode && episodeMinPct < -5) episodesOver5++;

  const last = series[series.length - 1];
  const avgRecovery =
    recoveryLengths.length > 0
      ? recoveryLengths.reduce((a, b) => a + b, 0) / recoveryLengths.length
      : 0;

  return {
    maxDrawdownPct: maxDDPct,
    maxDrawdownDollars: maxDD,
    maxDrawdownStart: maxDDStart,
    maxDrawdownEnd: maxDDEnd,
    currentDrawdownPct: last.underwaterPct,
    currentDrawdownDollars: last.underwaterDollars,
    avgRecoveryTrades: Math.round(avgRecovery),
    drawdownEpisodesOver5Pct: episodesOver5,
    maxDrawdownDuration: maxRunLen,
    timeUnderwaterPct: (underwaterCount / series.length) * 100,
  };
}
