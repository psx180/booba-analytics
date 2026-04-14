'use client';

interface IntroOverlayProps {
  onStartTour: () => void;
  onSkip: () => void;
}

export default function IntroOverlay({ onStartTour, onSkip }: IntroOverlayProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20000,
        background: 'rgba(0,0,0,0.70)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '16px',
          padding: '40px 48px',
          maxWidth: '420px',
          width: '90%',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '20px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        }}
      >
        {/* Avatar */}
        <div style={{ width: '150px', height: '150px' }}>
          <img
            src="/booba/calm.png"
            alt="Booba"
            width={150}
            height={150}
            onError={(e) => {
              // Fallback if image doesn't exist yet
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = 'none';
              const fallback = el.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = 'flex';
            }}
            style={{ borderRadius: '50%' }}
          />
          <div
            style={{
              display: 'none',
              width: '150px',
              height: '150px',
              borderRadius: '50%',
              background: '#21262d',
              border: '1px solid #30363d',
              fontSize: '80px',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            🐙
          </div>
        </div>

        {/* Headline */}
        <div>
          <h2 style={{ color: '#e6edf3', fontSize: '1.25rem', fontWeight: 700, margin: '0 0 8px' }}>
            Hi! I&apos;m Booba, your AI trading copilot for Pacifica.
          </h2>
          <p style={{ color: '#8b949e', fontSize: '0.95rem', lineHeight: 1.6, margin: 0 }}>
            Connect your wallet, and I&apos;ll automatically import your trades, analyze your patterns,
            and tell you what matters.
          </p>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '12px', width: '100%' }}>
          <button
            onClick={onStartTour}
            style={{
              flex: 1,
              padding: '10px 20px',
              borderRadius: '8px',
              border: 'none',
              background: '#1f6feb',
              color: '#ffffff',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 150ms ease',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#388bfd'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#1f6feb'; }}
          >
            Show Me Around
          </button>
          <button
            onClick={onSkip}
            style={{
              flex: 1,
              padding: '10px 20px',
              borderRadius: '8px',
              border: '1px solid #30363d',
              background: 'transparent',
              color: '#8b949e',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'color 150ms ease, border-color 150ms ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#c9d1d9';
              (e.currentTarget as HTMLButtonElement).style.borderColor = '#484f58';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#8b949e';
              (e.currentTarget as HTMLButtonElement).style.borderColor = '#30363d';
            }}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
