'use client';

import { useEffect, useRef } from 'react';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

const TOUR_STORAGE_KEY = 'hasSeenAppIntro';

const tourSteps = [
  {
    element: '[data-tour="wallet-connect"]',
    popover: {
      title: 'Connect Your Wallet',
      description: "First, connect your Pacifica wallet. I'll import your entire trade history automatically.",
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="network-switcher"]',
    popover: {
      title: 'Choose Your Network',
      description: 'Switch between mainnet and testnet here. I track them separately.',
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="nav-trades"]',
    popover: {
      title: 'Your Trades',
      description: 'Your trades live here — automatically grouped into positions. You can adjust grouping, filter by anything, and save custom views.',
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="nav-analytics"]',
    popover: {
      title: 'Deep Analytics',
      description: "Once I have enough trades, I'll analyze your Strategy, Execution, Risk, and Psychology. Each section opens with a plain-English verdict.",
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="nav-playbooks"]',
    popover: {
      title: 'Strategy Playbooks',
      description: "Define your strategy rules here. I'll automatically check if you followed them on every trade.",
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="dashboard-headline"]',
    popover: {
      title: 'Your Headline Insight',
      description: 'Your most important finding always shows here. No digging required — I surface what matters most.',
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  {
    element: '[data-tour="nav-signals"]',
    popover: {
      title: 'Signal Tracking',
      description: "Track calls from Discord or TradingView. I'll evaluate them against real price data and rank your callers.",
      side: 'bottom' as const,
      align: 'center' as const,
    },
  },
  // Final step: visual handoff from the realistic intro Booba (still anchored
  // bottom-center behind the tour) to the chibi avatar in the bottom-right.
  {
    element: '[data-tour="booba-chat"]',
    popover: {
      title: 'Your Companion',
      description: "I'll be right here whenever you need me. Click me to chat anytime — ask questions, filter your trades, or build a playbook.",
      side: 'left' as const,
      align: 'center' as const,
    },
  },
];

interface ProductTourProps {
  onComplete?: () => void;
}

export default function ProductTour({ onComplete }: ProductTourProps) {
  // React strict mode (Next.js dev) double-invokes effects, which caused
  // driver.js to mount two overlapping popovers — the doubled / blurred text.
  // Guarding init with a ref means we only ever drive() once per real mount.
  // Driver self-destructs via onDestroyStarted when the user finishes/closes,
  // so there's no unmount cleanup needed for the normal completion path.
  const startedRef = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      try {
        localStorage.setItem(TOUR_STORAGE_KEY, 'true');
      } catch {
        // ignore quota / privacy-mode failures
      }
      onComplete?.();
    };

    const driverObj = driver({
      showProgress: true,
      steps: tourSteps,
      nextBtnText: 'Next →',
      prevBtnText: '← Back',
      doneBtnText: 'Start Trading!',
      popoverClass: 'booba-tour-popover',
      onDestroyStarted: () => {
        driverObj.destroy();
        finish();
      },
    });

    driverObj.drive();
  }, [onComplete]);

  return null;
}

export function hasSeenProductTour(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
