'use client';

import { useState, useEffect } from 'react';

interface IntroOverlayProps {
  onStartTour: () => void;
  onSkip: () => void;
}

const INTRO_TEXT = "Hi! I'm Booba, your AI trading copilot for Pacifica. Connect your wallet and I'll analyze your trades, spot your patterns, and tell you what matters.";
const TYPEWRITER_DELAY = 30; // ms per character

export default function IntroOverlay({ onStartTour, onSkip }: IntroOverlayProps) {
  const [imageReady, setImageReady] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [typingDone, setTypingDone] = useState(false);
  const [showButton, setShowButton] = useState(false);

  // Start typewriter 500ms after image fade completes (800ms fade + 500ms delay)
  useEffect(() => {
    if (!imageReady) return;
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
  }, [imageReady]);

  // Show button shortly after typing completes
  useEffect(() => {
    if (!typingDone) return;
    const t = setTimeout(() => setShowButton(true), 300);
    return () => clearTimeout(t);
  }, [typingDone]);

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
      `}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 20000,
          background: 'rgba(13,17,23,0.92)',
          overflow: 'hidden',
        }}
      >
        {/* Text block — 25% from top */}
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
              onClick={onSkip}
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

        {/* Character image anchored to bottom-center */}
        <img
          src="/booba/intro.png"
          alt="Booba"
          onLoad={() => setImageReady(true)}
          onError={() => setImageReady(true)} // still start typewriter if image 404s
          style={{
            position: 'absolute',
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            maxHeight: '70vh',
            width: 'auto',
            objectFit: 'contain',
            animation: 'boobaFadeIn 800ms ease forwards',
            opacity: 0,
          }}
        />
      </div>
    </>
  );
}
