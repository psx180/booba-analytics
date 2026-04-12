/**
 * Timing metrics.
 *
 *   entryHour        — hour of day (0-23) of first entry, UTC
 *   entryDayOfWeek   — day of week (0-6, Sunday=0) of first entry, UTC
 *   entrySession     — asian (0-8), european (8-16), us (16-24), UTC
 *   holdTimeCategory — scalp (<15m), intraday (15m-24h), swing (1-7d), position (>7d)
 */

import type { MetricComputer, Position } from './base';

const SCALP_MAX_SEC = 15 * 60;
const INTRADAY_MAX_SEC = 24 * 60 * 60;
const SWING_MAX_SEC = 7 * 24 * 60 * 60;

export const timingComputer: MetricComputer = {
  name: 'timing',
  tier: 'fast',
  requiredFields: ['firstEntryTime', 'holdTimeSeconds'],

  compute(position: Position): Record<string, number | string | null> {
    const out: Record<string, number | string | null> = {
      entryHour: null,
      entryDayOfWeek: null,
      entrySession: null,
      holdTimeCategory: null,
    };

    if (position.firstEntryTime) {
      const entry = position.firstEntryTime;
      const hour = entry.getUTCHours();
      out.entryHour = hour;
      out.entryDayOfWeek = entry.getUTCDay();
      out.entrySession = sessionForHour(hour);
    }

    if (position.holdTimeSeconds != null) {
      out.holdTimeCategory = categorizeHoldTime(position.holdTimeSeconds);
    }

    return out;
  },
};

function sessionForHour(hour: number): string {
  if (hour < 8) return 'asian';
  if (hour < 16) return 'european';
  return 'us';
}

function categorizeHoldTime(seconds: number): string {
  if (seconds < SCALP_MAX_SEC) return 'scalp';
  if (seconds < INTRADAY_MAX_SEC) return 'intraday';
  if (seconds < SWING_MAX_SEC) return 'swing';
  return 'position';
}
