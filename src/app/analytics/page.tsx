import { Suspense } from 'react';
import AnalyticsClient from './AnalyticsClient';

export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsClient />
    </Suspense>
  );
}
