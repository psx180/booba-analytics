'use client';

/**
 * usePacificaLive — subscribe to /api/ws and expose live session state.
 *
 * EventSource is a natural fit for SSE but can't send an `Authorization`
 * header, so in Privy mode we'd lose auth. Using fetch + ReadableStream
 * parses the same SSE format, carries the Bearer token correctly, and
 * works in dev-bypass mode too.
 *
 * Consumers typically only care about a few pieces of state:
 *   - openPositions:   live unrealized P&L rows (dashboard "Open Positions")
 *   - lastTrade:       most recent new_trade event (triggers thesis popup)
 *   - lastClosedTrade: most recent position_closed event (refresh dashboard)
 *   - connected:       upstream Pacifica WS health (drives LIVE indicator)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { isDevBypass } from '@/app/privy-env';

export interface LivePositionRow {
  symbol: string;
  side: 'long' | 'short';
  amount: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface InitialLivePosition {
  symbol: string;
  side: 'long' | 'short';
  amount: number;
  entryPrice: number;
}

export interface NewTradeData {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  amount: number;
  price: number;
  pnl: number | null;
  isNewPosition: boolean;
  receivedAt: number;
  sessionWarning?: {
    tradeNumber: number;
    optimalStop: number;
    avgPnlAfterOptimal: number;
  };
  regimeContext?: {
    currentRegime: string;
    assetRegimeWinRate: number;
    baselineWinRate: number;
    assetRegimeAvgPnl: number;
    tradeCountInRegime: number;
  };
}

export interface PositionClosedData {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  pnl: number;
  receivedAt: number;
}

export interface PacificaLiveState {
  openPositions: LivePositionRow[];
  initialPositions: InitialLivePosition[];
  lastTrade: NewTradeData | null;
  lastClosedTrade: PositionClosedData | null;
  connected: boolean;
  streamOpen: boolean;
}

export function usePacificaLive(): PacificaLiveState {
  const [openPositions, setOpenPositions] = useState<LivePositionRow[]>([]);
  const [initialPositions, setInitialPositions] = useState<InitialLivePosition[]>([]);
  const [lastTrade, setLastTrade] = useState<NewTradeData | null>(null);
  const [lastClosedTrade, setLastClosedTrade] = useState<PositionClosedData | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);

  const devBypass = isDevBypass();
  const getTokenRef = useRef<(() => Promise<string | null>) | null>(null);
  if (!devBypass) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { getAccessToken } = usePrivy();
    getTokenRef.current = getAccessToken;
  }

  const handleEvent = useCallback((name: string, data: unknown) => {
    switch (name) {
      case 'open': {
        const d = data as { positions: InitialLivePosition[] };
        setInitialPositions(d.positions);
        break;
      }
      case 'status': {
        const d = data as { connected: boolean };
        setConnected(d.connected);
        break;
      }
      case 'price_update': {
        const d = data as { positions: LivePositionRow[] };
        setOpenPositions(d.positions);
        break;
      }
      case 'new_trade': {
        const d = data as Omit<NewTradeData, 'receivedAt'>;
        setLastTrade({ ...d, receivedAt: Date.now() });
        break;
      }
      case 'position_closed': {
        const d = data as Omit<PositionClosedData, 'receivedAt'>;
        setLastClosedTrade({ ...d, receivedAt: Date.now() });
        break;
      }
      case 'error': {
        const d = data as { message: string };
        console.warn('[live] error event', d.message);
        break;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (!devBypass) {
          const token = await getTokenRef.current?.();
          if (token) headers.Authorization = `Bearer ${token}`;
        }

        const res = await fetch('/api/ws', { headers, signal: controller.signal });
        if (!res.ok || !res.body) {
          console.warn('[live] /api/ws response not ok', res.status);
          return;
        }
        setStreamOpen(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by \n\n. Parse in place.
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            if (!raw || raw.startsWith(':')) continue; // keepalive comment

            let evName = 'message';
            const dataParts: string[] = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) evName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataParts.push(line.slice(5).trim());
            }
            if (dataParts.length === 0) continue;
            try {
              const parsed = JSON.parse(dataParts.join('\n'));
              handleEvent(evName, parsed);
            } catch {
              // Malformed frame — skip.
            }
          }
        }
      } catch (err) {
        if (!cancelled) console.warn('[live] stream ended', err);
      } finally {
        setStreamOpen(false);
        setConnected(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [devBypass, handleEvent]);

  return {
    openPositions,
    initialPositions,
    lastTrade,
    lastClosedTrade,
    connected,
    streamOpen,
  };
}
