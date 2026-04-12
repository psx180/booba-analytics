'use client';

import { useEffect, useState, useRef } from 'react';

interface SpeechBubbleProps {
  text: string;
  onDismiss: () => void;
}

const PREVIEW_LENGTH = 120;

export default function SpeechBubble({ text, onDismiss }: SpeechBubbleProps) {
  const [visible, setVisible] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const isLong = text.length > PREVIEW_LENGTH;
  const displayText = isLong ? text.slice(0, PREVIEW_LENGTH) + '...' : text;

  useEffect(() => {
    // Slight delay so the fade-in is visible
    const showTimer = setTimeout(() => setVisible(true), 30);

    const dismissTimer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismissRef.current(), 300);
    }, 8000);

    return () => {
      clearTimeout(showTimer);
      clearTimeout(dismissTimer);
    };
  }, []);

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(4px)',
        transition: 'opacity 300ms ease, transform 300ms ease',
        maxWidth: '250px',
        minWidth: '140px',
        backgroundColor: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '8px',
        padding: '8px 10px',
        fontSize: '12px',
        lineHeight: '1.5',
        color: '#c9d1d9',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {displayText}
      {isLong && (
        <button
          onClick={() => { setVisible(false); setTimeout(onDismiss, 300); }}
          style={{
            color: '#58a6ff',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '0 0 0 4px',
          }}
        >
          See more
        </button>
      )}
      {/* Triangle pointer pointing right (toward Booba) */}
      <div
        style={{
          position: 'absolute',
          right: '-7px',
          bottom: '14px',
          width: 0,
          height: 0,
          borderTop: '6px solid transparent',
          borderBottom: '6px solid transparent',
          borderLeft: '7px solid #30363d',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: '-5px',
          bottom: '15px',
          width: 0,
          height: 0,
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderLeft: '6px solid #161b22',
        }}
      />
    </div>
  );
}
