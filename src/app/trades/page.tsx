import { Suspense } from 'react';
import TradesClient from './TradesClient';
import { TradesFilterProvider } from '@/contexts/TradesFilterContext';

export default function TradesPage() {
  return (
    <TradesFilterProvider>
      <Suspense>
        <TradesClient />
      </Suspense>
    </TradesFilterProvider>
  );
}
