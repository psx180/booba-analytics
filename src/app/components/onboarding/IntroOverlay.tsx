'use client';

import { useState, useEffect } from 'react';

export type IntroPhase = 'intro' | 'companion' | 'fading';

interface IntroOverlayProps {
  phase: IntroPhase;
  onDismiss: () => void;
  onFadeComplete?: () => void;
}

const INTRO_TEXT = "Hi! I'm Booba, your AI trading copilot for Pacifica. Connect your wallet and I'll analyze your trades, spot your patterns, and tell you what matters.";
const TYPEWRITER_DELAY = 30; // ms per character
const FADE_OUT_MS = 600;

export default function IntroOverlay({ phase, onDismiss, onFadeComplete }: IntroOverlayProps) {
  const [imageReady, setImageReady] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [typingDone, setTypingDone] = useState(false);
  const [showButton, setShowButton] = useState(false);

  const showBackdrop = phase === 'intro';
  const showText = phase === 'intro';

  // Start typewriter 500ms after image fade completes (800ms fade + 500ms delay)
  useEffect(() => {
    if (!imageReady || phase !== 'intro') return;
    const startDelay = setTimeout(() => {
      let i = 0;
      const interval = setInterval(() => {
        i++;
        setTypedText(INTRO_TEXT.slice(0, i));
        if (i >= INTRO_TEXT.length) {
          clearInterval(interval);
          setTypingDone(true);
        }
      }, TYPEWRITER_DELAY);
      return () => clearInterval(interval);
    }, 500);
    return () => clearTimeout(startDelay);
  }, [imageReady, phase]);

  // Show button shortly after typing completes
  useEffect(() => {
    if (!typingDone) return;
    const t = setTimeout(() => setShowButton(true), 300);
    return () => clearTimeout(t);
  }, [typingDone]);

  // When parent flips to 'fading', schedule onFadeComplete after the CSS animation runs.
  useEffect(() => {
    if (phase !== 'fading' || !onFadeComplete) return;
    const t = setTimeout(onFadeComplete, FADE_OUT_MS);
    return () => clearTimeout(t);
  }, [phase, onFadeComplete]);

  return (
    <>
      <style>{`
        @keyframes boobaFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes boobaBtnIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes boobaFadeOut {
          from { opacity: 1; transform: translateX(-50%) translateY(0); }
          to   { opacity: 0; transform: translateX(-50%) translateY(20px); }
        }
        @keyframes boobaBackdropOut {
          from { background: rgba(13,17,23,0.92); }
          to   { background: rgba(13,17,23,0); }
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          // Backdrop sits above page, character image sits above backdrop.
          // During companion/fading phases the wrapper itself becomes click-through
          // so the tour highlights underneath remain interactive.
          zIndex: showBackdrop ? 20000 : 9000,
          background: showBackdrop ? 'rgba(13,17,23,0.92)' : 'transparent',
          transition: showBackdrop ? undefined : 'background 350ms ease',
          overflow: 'hidden',
          pointerEvents: showBackdrop ? 'auto' : 'none',
        }}
      >
        {showText && (
          <div
            style={{
              position: 'absolute',
              top: '25%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '100%',
              maxWidth: '500px',
              textAlign: 'center',
              padding: '0 24px',
              zIndex: 1,
              pointerEvents: 'auto',
              // Counter-zoom: html has zoom: 0.9 — without this the text lands
              // on fractional pixels and renders blurred. Matches the pattern
              // used by .booba-tour-popover in globals.css.
              zoom: 1.1111111,
            }}
          >
            <p
              style={{
                color: '#e6edf3',
                fontSize: '1.125rem',
                lineHeight: 1.7,
                margin: '0 0 24px',
                minHeight: '5em',
              }}
            >
              {typedText}
              {!typingDone && <span style={{ opacity: 0.6 }}>▍</span>}
            </p>

            {showButton && (
              <button
                onClick={onDismiss}
                style={{
                  display: 'inline-block',
                  padding: '11px 32px',
                  borderRadius: '8px',
                  border: 'none',
                  background: '#1f6feb',
                  color: '#ffffff',
                  fontSize: '1rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  animation: 'boobaBtnIn 400ms ease forwards',
                  transition: 'background 150ms ease',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#388bfd'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#1f6feb'; }}
              >
                Let&apos;s Go
              </button>
            )}
          </div>
        )}

        {/* Character image anchored to bottom-center, persists through every phase. */}
        <img
          src="/booba/intro.png"
          alt="Booba"
          onLoad={() => setImageReady(true)}
          onError={() => setImageReady(true)}
          style={{
            position: 'absolute',
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            maxHeight: '70vh',
            width: 'auto',
            objectFit: 'contain',
            // Keep the entry animation on first mount; fade out when parent
            // signals 'fading'. In 'companion' phase we hold opacity 1.
            animation: phase === 'fading'
              ? `boobaFadeOut ${FADE_OUT_MS}ms ease forwards`
              : 'boobaFadeIn 800ms ease forwards',
            opacity: phase === 'fading' ? 1 : 0,
            pointerEvents: 'none',
          }}
        />
      </div>
    </>
  );
}
