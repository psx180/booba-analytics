import type { PrismaClient } from '../../../../generated/prisma/client';
import type { EquitySourceProvider, EquityProviderMode } from './types';
import { LegacyPnlBasedProvider } from './legacy-pnl-based';
import { StartingCapitalProvider } from './starting-capital';
import { SnapshotTwrProvider } from './snapshot-twr';
import { prisma } from '../../../lib/prisma';
export type {
  EquitySourceProvider,
  EquityPoint,
  DailyReturn,
  DrawdownSummary,
  EquityProviderMode,
} from './types';
export { computeDrawdownSummary } from './drawdown';
export { computeSharpe, computeSortino, computeCalmar } from './risk-metrics';
export { LegacyPnlBasedProvider } from './legacy-pnl-based';
export { StartingCapitalProvider } from './starting-capital';
export { SnapshotTwrProvider } from './snapshot-twr';
export function createEquityProvider(
  mode: EquityProviderMode,
  db?: PrismaClient,
): EquitySourceProvider {
  const database = (db ?? prisma) as PrismaClient;
  switch (mode) {
    case 'legacy':
      return new LegacyPnlBasedProvider();
    case 'starting-capital':
      return new StartingCapitalProvider(database);
    case 'snapshot-twr':
      return new SnapshotTwrProvider(database);
    default:
      return new LegacyPnlBasedProvider();
  }
}
const mode = (process.env.EQUITY_PROVIDER_MODE ?? 'starting-capital') as EquityProviderMode;
export const defaultEquityProvider = createEquityProvider(mode);