import type { PrismaClient } from '../../../../generated/prisma/client';
import type { EquitySourceProvider, EquityProviderMode } from './types';
import { LegacyPnlBasedProvider } from './legacy-pnl-based';
import { StartingCapitalProvider } from './starting-capital';
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
      console.warn(
        '[equity] snapshot-twr provider not yet implemented, falling back to legacy',
      );
      return new LegacyPnlBasedProvider();
    default:
      return new LegacyPnlBasedProvider();
  }
}

const mode = (process.env.EQUITY_PROVIDER_MODE ?? 'starting-capital') as EquityProviderMode;
export const defaultEquityProvider = createEquityProvider(mode);
