/**
 * Base re-export for metric computers.
 *
 * Metric computers implement MetricComputer from types.ts.
 * Each computer is a pure function that turns a position into a set of
 * key-value metric pairs, which the analytics service persists on the
 * position record.
 */

export type { MetricComputer, Position, Candle } from '../types';
