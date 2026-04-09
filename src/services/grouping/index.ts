/**
 * grouping/index.ts
 *
 * Public API for the hierarchical grouping pipeline.
 */

export { GroupingService } from './grouping-service';
export { FillToOrderLevel } from './levels/fill-to-order';
export { OrderToPositionLevel } from './levels/order-to-position';
export { PositionLinkingLevel } from './levels/position-linking';
export type {
  Fill,
  OrderGroupData,
  PositionData,
  LinkedStrategyData,
  GroupingSummary,
  TradeUnit,
  PositionType,
  StrategyType,
  POSITION_TYPES,
  STRATEGY_TYPES,
} from './types';
