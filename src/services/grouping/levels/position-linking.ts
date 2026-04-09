/**
 * Level 3 — Position Linking
 *
 * Links Positions into LinkedStrategies. Currently manual only —
 * the user selects positions and specifies the strategy type.
 *
 * Validates link type:
 *   - delta_neutral: same asset, opposite directions, overlapping time
 *   - pairs_trade: different assets, opposite directions, similar notional, overlapping time
 *   - basis_trade: spot + perp on same asset (same as delta_neutral for now)
 *
 * Computes aggregate fields: combined P&L, net delta, spread P&L.
 *
 * Answers: "What combined trade were these positions part of?"
 */

import type { PositionData, LinkedStrategyData, StrategyType } from '../types';

export class PositionLinkingLevel {
  readonly name = 'position-linking';

  /**
   * Link a set of positions into a LinkedStrategy.
   * Validates that the link type makes sense for these positions.
   */
  link(positions: PositionData[], strategyType: StrategyType): LinkedStrategyData {
    if (positions.length < 2) {
      throw new Error('Need at least 2 positions to link');
    }

    this.validate(positions, strategyType);
    return this.buildLinkedStrategy(positions, strategyType);
  }

  private validate(positions: PositionData[], type: StrategyType): void {
    const assets = [...new Set(positions.map((p) => p.asset))];
    const directions = [...new Set(positions.map((p) => p.direction))];

    switch (type) {
      case 'delta_neutral':
      case 'basis_trade':
        // Same asset, opposite directions
        if (assets.length !== 1) {
          throw new Error(`${type} requires positions on the same asset, got: ${assets.join(', ')}`);
        }
        if (directions.length < 2) {
          throw new Error(`${type} requires opposite directions`);
        }
        break;

      case 'pairs_trade':
        // Different assets, should have opposite directions
        if (assets.length < 2) {
          throw new Error('pairs_trade requires positions on different assets');
        }
        break;
    }
  }

  private buildLinkedStrategy(
    positions: PositionData[],
    strategyType: StrategyType,
  ): LinkedStrategyData {
    const combinedPnl = positions.reduce((s, p) => s + p.pnl, 0);
    const combinedFees = positions.reduce((s, p) => s + p.fees, 0);
    const combinedFunding = positions.reduce((s, p) => s + p.funding, 0);

    // Net delta: long exposure minus short exposure
    const netDelta = positions.reduce((s, p) => {
      const sign = p.direction === 'long' ? 1 : -1;
      return s + sign * (p.totalSize * p.averageEntryPrice);
    }, 0);

    // Spread P&L for pairs trades: leg A return minus leg B return
    let spreadPnl: number | null = null;
    if (strategyType === 'pairs_trade' && positions.length === 2) {
      spreadPnl = positions[0].pnl - positions[1].pnl;
    }

    const allTimes = positions
      .flatMap((p) => [p.firstEntryTime, p.lastExitTime])
      .filter((t): t is Date => t != null);
    const firstEntryTime = allTimes.length > 0
      ? new Date(Math.min(...allTimes.map((t) => t.getTime())))
      : null;
    const lastExitTime = allTimes.length > 0
      ? new Date(Math.max(...allTimes.map((t) => t.getTime())))
      : null;

    const hasOpen = positions.some((p) => p.status === 'open');
    const minConfidence = Math.min(...positions.map((p) => p.confidence));

    return {
      id: `ls_${positions.map((p) => p.id).join('_')}`,
      strategyType,
      legs: positions,
      combinedPnl,
      combinedFees,
      combinedFunding,
      netDelta,
      spreadPnl,
      pnl: combinedPnl,
      fees: combinedFees,
      funding: combinedFunding,
      status: hasOpen ? 'open' : 'closed',
      firstEntryTime,
      lastExitTime,
      tradeType: strategyType,
      confidence: minConfidence,
      regimeAtEntry: positions[0].regimeAtEntry,
      sentimentAtEntry: positions[0].sentimentAtEntry,
    };
  }
}
