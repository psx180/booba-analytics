import TradesClient from './TradesClient';
import { TradesFilterProvider } from '@/contexts/TradesFilterContext';

export default function TradesPage() {
  return (
    <TradesFilterProvider>
      <div>
        <h1 className="text-lg font-semibold text-white mb-4">Trades</h1>
        <TradesClient />
      </div>
    </TradesFilterProvider>
  );
}
