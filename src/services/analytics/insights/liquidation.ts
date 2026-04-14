/**
 * Liquidation insight detector.
 *
 * Detects positions that were forcibly closed by a liquidation or settlement
 * event (tradeType === 'liquidated'). Generates a critical warning per asset
 * so Booba surfaces it in the speech bubble and insight cards.
 */

import type { InsightDetector, Insight, Position } from './base';
import { computeImpactScore } from '../statistics';

export const liquidationDetector: InsightDetector = {
  name: 'liquidation',
  minimumPositions: 1,
  dimensions: ['tradeType', 'asset', 'aggregatePnl'],

  detect(positions: Position[]): Insight[] {
    const liquidated = positions.filter(
      (p) => p.tradeType === 'liquidated' && p.status === 'closed',
    );

    if (liquidated.length === 0) return [];

    // Group by asset so we can name each one in the message
    const byAsset: Record<string, Position[]> = {};
    for (const p of liquidated) {
      (byAsset[p.asset] ??= []).push(p);
    }

    const assets      = Object.keys(byAsset).sort();
    const totalCost   = liquidated.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
    const assetList   = assets.join(', ');
    const assetPhrase = assets.length === 1 ? `on ${assets[0]}` : `on ${assetList}`;

    const statTest = {
      testName: 'liquidation_count',
      pValue: 0.001,
      effectSize: 1.0,
      sampleSizeA: liquidated.length,
      sampleSizeB: 0,
      isSignificant: true,
      description:
        `${liquidated.length} position${liquidated.length > 1 ? 's were' : ' was'} ` +
        `forcibly closed by liquidation or settlement — a definitive risk event.`,
    };

    const impactScore = computeImpactScore(Math.abs(totalCost), statTest, 1.0);

    const assetBreakdown: Record<string, any> = {};
    for (const [asset, ps] of Object.entries(byAsset)) {
      const cost = ps.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
      assetBreakdown[asset] = {
        count:     ps.length,
        totalCost: Math.round(cost * 100) / 100,
      };
    }

    return [{
      module: 'liquidation',
      title: `Liquidation${liquidated.length > 1 ? 's' : ''} Detected`,
      description:
        `You were liquidated ${assetPhrase}. Review your leverage and margin management.`,
      suggestion:
        'Consider reducing position sizes, setting tighter stops, and monitoring ' +
        'your margin ratio through the Booba stress tester before entering high-leverage trades.',
      severity:           'critical',
      confidence:         1.0,
      affectedPositions:  liquidated.map((p) => p.id),
      data: {
        liquidationCount: liquidated.length,
        totalCost:        Math.round(totalCost * 100) / 100,
        assets,
        assetBreakdown,
      },
      statistics:    [statTest],
      impactScore,
      category:      'risk',
      isSignificant: true,
      sampleSize:    liquidated.length,
    }];
  },
};
