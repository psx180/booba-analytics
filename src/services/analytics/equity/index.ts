import type { PrismaClient } from '../../../../generated/prisma/client';
import type { EquitySourceProvider, EquityProviderMode } from './types';
import { LegacyPnlBasedProvider } from './legacy-pnl-based';
import { StartingCapitalProvider } from './starting-capital';
import { SnapshotTwrProvider } from './snapshot-twr';
import { ReconstructedProvider } from './reconstructed';
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
export { ReconstructedProvider } from './reconstructed';
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
    case 'reconstructed':
      return new ReconstructedProvider(database);
    default:
      return new ReconstructedProvider(database);
  }
}
const mode = (process.env.EQUITY_PROVIDER_MODE ?? 'reconstructed') as EquityProviderMode;
export const defaultEquityProvider = createEquityProvider(mode);