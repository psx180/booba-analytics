import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

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
    element: '[data-tour="booba-chat"]',
    popover: {
      title: 'Chat With Me',
      description: "Ask me anything. 'Why am I losing?' 'Show my BTC losses.' 'Create a playbook.' I can analyze, filter, navigate, and build things for you.",
      side: 'left' as const,
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
];

export function startGuidedTour() {
  const driverObj = driver({
    showProgress: true,
    steps: tourSteps,
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Start Trading!',
    onDestroyStarted: () => {
      localStorage.setItem('hasSeenAppIntro', 'true');
      driverObj.destroy();
    },
    popoverClass: 'booba-tour-popover',
  });

  driverObj.drive();
}
