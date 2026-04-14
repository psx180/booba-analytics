'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import SpeechBubble from './SpeechBubble';

// ── Types ─────────────────────────────────────────────────────────────────────

type MoodState = 'money_mode' | 'calm' | 'alert' | 'nervous' | 'panicking';
type DisplayMood = MoodState | 'pout' | 'excited';

export interface BoobaAvatarProps {
  healthScore: number;             // 0-100
  size?: 'small' | 'medium';       // small=60px (default), medium=120px
  insight?: string | null;
  insightCategory?: string;
  eloTrend?: 'improving' | 'declining' | 'stable';
  wartTrend?: number;
  isHidden?: boolean;
  onHide?: () => void;
  onShow?: () => void;
  /** When set, clicking the avatar toggles the chat panel open/closed */
  onChatToggle?: () => void;
  /** Whether the chat panel is currently open */
  chatOpen?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_MOODS: DisplayMood[] = [
  'money_mode', 'calm', 'alert', 'nervous', 'panicking', 'pout', 'excited',
];

const MOOD_ANIMATION_CLASS: Record<DisplayMood, string> = {
  money_mode: 'booba-money-mode',
  calm:       'booba-calm',
  alert:      'booba-alert',
  nervous:    'booba-nervous',
  panicking:  'booba-panicking',
  pout:       '',
  excited:    'booba-money-mode', // reuse float for excited
};

const POUT_MESSAGES = [
  "Fine, I'll watch your margin ratio from over here...",
  "You know where to find me...",
  "I'll just be in the extension then...",
];

const EXCITED_MESSAGES = [
  "You missed me!",
  "I've been watching your trades!",
];

const LS_KEY = 'booba-hidden';

// ── Helpers ───────────────────────────────────────────────────────────────────

function moodFromScore(score: number): MoodState {
  if (score >= 80) return 'money_mode';
  if (score >= 60) return 'calm';
  if (score >= 40) return 'alert';
  if (score >= 20) return 'nervous';
  return 'panicking';
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoobaAvatar({
  healthScore,
  size = 'small',
  insight,
  onHide,
  onShow,
  onChatToggle,
  chatOpen,
}: BoobaAvatarProps) {
  const px = size === 'medium' ? 120 : 60;

  // Hidden state — persisted in localStorage
  const [hidden, setHidden] = useState(false);
  // Fading out before hiding
  const [fadingOut, setFadingOut] = useState(false);
  // Current displayed mood (may be overridden by special states)
  const [displayMood, setDisplayMood] = useState<DisplayMood>(() => moodFromScore(healthScore));
  // Show hover controls
  const [hovered, setHovered] = useState(false);
  // Speech bubble state
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [bubbleKey, setBubbleKey] = useState(0);

  const specialStateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setHidden(localStorage.getItem(LS_KEY) === 'true');
    }
  }, []);

  // Update base mood when healthScore changes (only when no special state active)
  const baseMood = moodFromScore(healthScore);
  useEffect(() => {
    if (
      displayMood !== 'pout' &&
      displayMood !== 'excited'
    ) {
      setDisplayMood(baseMood);
    }
  }, [baseMood]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chat open → excited mood; chat close → return to base mood
  useEffect(() => {
    if (chatOpen) {
      setDisplayMood('excited');
    } else if (displayMood === 'excited') {
      setDisplayMood(baseMood);
    }
  }, [chatOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show insight bubble when insight prop changes
  const prevInsightRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (insight && insight !== prevInsightRef.current && !hidden) {
      setBubbleText(insight);
      setBubbleKey((k) => k + 1);
    }
    prevInsightRef.current = insight;
  }, [insight, hidden]);

  const clearSpecialTimer = () => {
    if (specialStateTimer.current) {
      clearTimeout(specialStateTimer.current);
      specialStateTimer.current = null;
    }
  };

  const handleHide = useCallback(() => {
    clearSpecialTimer();
    setDisplayMood('pout');
    setBubbleText(pick(POUT_MESSAGES));
    setBubbleKey((k) => k + 1);

    specialStateTimer.current = setTimeout(() => {
      setFadingOut(true);
      setTimeout(() => {
        setHidden(true);
        setFadingOut(false);
        setDisplayMood(baseMood);
        setBubbleText(null);
        localStorage.setItem(LS_KEY, 'true');
        onHide?.();
      }, 300);
    }, 2000);
  }, [baseMood, onHide]);

  const handleShow = useCallback(() => {
    setHidden(false);
    localStorage.setItem(LS_KEY, 'false');
    clearSpecialTimer();
    setDisplayMood('excited');
    setBubbleText(pick(EXCITED_MESSAGES));
    setBubbleKey((k) => k + 1);

    specialStateTimer.current = setTimeout(() => {
      setDisplayMood(baseMood);
      onShow?.();
    }, 2000);
  }, [baseMood, onShow]);

  // Cleanup on unmount
  useEffect(() => () => clearSpecialTimer(), []);

  // ── Render: hidden → show button ──────────────────────────────────────────
  if (hidden) {
    return (
      <div
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          zIndex: 9999,
        }}
      >
        <button
          onClick={handleShow}
          title="Show Booba"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: '#21262d',
            border: '1px solid #30363d',
            color: '#6e7681',
            cursor: 'pointer',
            fontSize: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 200ms ease',
            opacity: 0.7,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '1';
            (e.currentTarget as HTMLButtonElement).style.color = '#c9d1d9';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '0.7';
            (e.currentTarget as HTMLButtonElement).style.color = '#6e7681';
          }}
        >
          ◉
        </button>
      </div>
    );
  }

  // ── Render: avatar ────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-end',
        gap: '8px',
      }}
    >
      {/* Speech bubble — rendered to the left */}
      {bubbleText && (
        <SpeechBubble
          key={bubbleKey}
          text={bubbleText}
          onDismiss={() => setBubbleText(null)}
        />
      )}

      {/* Avatar container */}
      <div
        data-tour="booba-chat"
        style={{
          position: 'relative',
          width: `${px}px`,
          height: `${px}px`,
          opacity: fadingOut ? 0 : 1,
          transition: 'opacity 300ms ease',
          cursor: onChatToggle ? 'pointer' : 'default',
        }}
        onClick={onChatToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Mood images — all stacked, crossfade via opacity */}
        {ALL_MOODS.map((mood) => (
          <img
            key={mood}
            src={`/booba/${mood === 'money_mode' ? 'money-mode' : mood}.svg`}
            alt={mood}
            width={px}
            height={px}
            className={displayMood === mood ? MOOD_ANIMATION_CLASS[mood] : ''}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              opacity: displayMood === mood ? 1 : 0,
              transition: 'opacity 300ms ease',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
            draggable={false}
          />
        ))}

        {/* Hide button — shown on hover */}
        {hovered && !fadingOut && (
          <button
            onClick={handleHide}
            title="Hide Booba"
            style={{
              position: 'absolute',
              top: '-6px',
              right: '-6px',
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              background: '#21262d',
              border: '1px solid #30363d',
              color: '#6e7681',
              cursor: 'pointer',
              fontSize: '10px',
              lineHeight: '1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1,
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#c9d1d9';
              (e.currentTarget as HTMLButtonElement).style.background = '#30363d';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#6e7681';
              (e.currentTarget as HTMLButtonElement).style.background = '#21262d';
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
