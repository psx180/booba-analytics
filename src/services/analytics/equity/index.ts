import type { EquitySourceProvider, EquityProviderMode } from './types';
import { LegacyPnlBasedProvider } from './legacy-pnl-based';

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

export function createEquityProvider(mode: EquityProviderMode): EquitySourceProvider {
  switch (mode) {
    case 'legacy':
      return new LegacyPnlBasedProvider();
    case 'starting-capital':
      console.warn(
        '[equity] starting-capital provider not yet implemented, falling back to legacy',
      );
      return new LegacyPnlBasedProvider();
    case 'snapshot-twr':
      console.warn(
        '[equity] snapshot-twr provider not yet implemented, falling back to legacy',
      );
      return new LegacyPnlBasedProvider();
    default:
      return new LegacyPnlBasedProvider();
  }
}

const mode = (process.env.EQUITY_PROVIDER_MODE ?? 'legacy') as EquityProviderMode;
export const defaultEquityProvider = createEquityProvider(mode);
