'use client';

import { useState } from 'react';
import { useAuthFetch } from '@/lib/api-client';

interface ParsedSignal {
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number | null;
  targetPrices: number[] | null;
  stopPrice: number | null;
  callerName: string | null;
}

interface PreviewCard {
  raw: string;
  parsed: ParsedSignal | null;
  callerName: string;
  source: string;
  channelName: string;
  confirmed: boolean;
  saving: boolean;
  error: string | null;
}

interface SignalInputProps {
  onSignalAdded: () => void;
  onAskBooba?: () => void;
}

const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'ARB', 'OP', 'AVAX', 'MATIC', 'LINK', 'Other'];
const SOURCES = ['discord', 'twitter', 'telegram', 'manual'];

export default function SignalInput({ onSignalAdded, onAskBooba }: SignalInputProps) {
  const [pasteText, setPasteText]     = useState('');
  const [parsing, setParsing]         = useState(false);
  const [previews, setPreviews]       = useState<PreviewCard[]>([]);
  const [defaultSource, setDefaultSource] = useState('discord');
  const [showManual, setShowManual]   = useState(false);
  const [isFocused, setIsFocused]     = useState(false);

  // Manual form
  const [manualAsset, setManualAsset]           = useState('BTC');
  const [manualCustomAsset, setManualCustomAsset] = useState('');
  const [manualDirection, setManualDirection]   = useState<'LONG' | 'SHORT'>('LONG');
  const [manualEntry, setManualEntry]           = useState('');
  const [manualTarget, setManualTarget]         = useState('');
  const [manualStop, setManualStop]             = useState('');
  const [manualCaller, setManualCaller]         = useState('');
  const [manualSource, setManualSource]         = useState('manual');
  const [manualChannel, setManualChannel]       = useState('');
  const [manualSaving, setManualSaving]         = useState(false);
  const [manualError, setManualError]           = useState<string | null>(null);

  const authFetch = useAuthFetch();

  const isExpanded = isFocused || pasteText.length > 0;

  async function handleParse() {
    const lines = pasteText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    setParsing(true);
    const newPreviews: PreviewCard[] = [];

    for (const line of lines) {
      try {
        const res = await authFetch('/api/signals/parse', {
          method: 'POST',
          body: JSON.stringify({ text: line, source: defaultSource }),
        });
        const data = await res.json();
        newPreviews.push({
          raw: line,
          parsed: data.signal,
          callerName: data.signal?.callerName ?? '',
          source: defaultSource,
          channelName: '',
          confirmed: false,
          saving: false,
          error: null,
        });
      } catch {
        newPreviews.push({
          raw: line, parsed: null, callerName: '', source: defaultSource,
          channelName: '', confirmed: false, saving: false, error: 'Parse failed',
        });
      }
    }

    setPreviews(newPreviews);
    setParsing(false);
  }

  function updatePreview(index: number, patch: Partial<PreviewCard>) {
    setPreviews((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  async function handleAddSignal(index: number) {
    const card = previews[index];
    if (!card.parsed) return;
    if (!card.callerName.trim()) { updatePreview(index, { error: 'Caller name required' }); return; }

    updatePreview(index, { saving: true, error: null });
    try {
      const res = await authFetch('/api/signals', {
        method: 'POST',
        body: JSON.stringify({
          asset: card.parsed.asset,
          direction: card.parsed.direction,
          entryPrice: card.parsed.entryPrice,
          targetPrice: card.parsed.targetPrice,
          targetPrices: card.parsed.targetPrices,
          stopPrice: card.parsed.stopPrice,
          callerName: card.callerName.trim(),
          source: card.source,
          channelName: card.channelName || null,
          rawMessage: card.raw,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        updatePreview(index, { saving: false, error: err.error ?? 'Failed to save' });
        return;
      }
      updatePreview(index, { saving: false, confirmed: true });
      onSignalAdded();
    } catch {
      updatePreview(index, { saving: false, error: 'Network error' });
    }
  }

  async function handleManualSubmit() {
    const asset = manualAsset === 'Other' ? manualCustomAsset.trim().toUpperCase() : manualAsset;
    if (!asset) { setManualError('Asset required'); return; }
    if (!manualEntry || isNaN(parseFloat(manualEntry))) { setManualError('Entry price required'); return; }
    if (!manualCaller.trim()) { setManualError('Caller name required'); return; }

    setManualSaving(true);
    setManualError(null);
    try {
      const res = await authFetch('/api/signals', {
        method: 'POST',
        body: JSON.stringify({
          asset,
          direction: manualDirection,
          entryPrice: parseFloat(manualEntry),
          targetPrice: manualTarget ? parseFloat(manualTarget) : null,
          stopPrice: manualStop ? parseFloat(manualStop) : null,
          callerName: manualCaller.trim(),
          source: manualSource,
          channelName: manualChannel || null,
          rawMessage: null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setManualError(err.error ?? 'Failed to save');
        setManualSaving(false);
        return;
      }
      setManualEntry(''); setManualTarget(''); setManualStop('');
      setManualCaller(''); setManualChannel('');
      setManualSaving(false);
      setShowManual(false);
      onSignalAdded();
    } catch {
      setManualError('Network error');
      setManualSaving(false);
    }
  }

  return (
    <div>
      {/* ── Compact input row ── */}
      <div style={{
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '8px',
        padding: '8px 12px',
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
      }}>
        {/* Paste textarea — single line when collapsed, grows on focus */}
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="📋 Paste a signal or call…"
          rows={isExpanded ? 3 : 1}
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: '6px',
            border: '1px solid #30363d',
            background: '#0d1117',
            color: '#c9d1d9',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
            resize: 'none',
            fontFamily: 'inherit',
            height: isExpanded ? '72px' : '34px',
            transition: 'height 150ms ease',
            lineHeight: '1.4',
          }}
        />

        {/* Controls — stay in the row, align to top */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0, paddingTop: '1px' }}>
          <select
            value={defaultSource}
            onChange={(e) => setDefaultSource(e.target.value)}
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              border: '1px solid #30363d',
              background: '#21262d',
              color: '#c9d1d9',
              fontSize: '12px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <button
            onClick={handleParse}
            disabled={parsing || !pasteText.trim()}
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: 'none',
              background: parsing || !pasteText.trim() ? '#21262d' : '#1f6feb',
              color: parsing || !pasteText.trim() ? '#484f58' : '#ffffff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: parsing || !pasteText.trim() ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {parsing ? '…' : 'Parse'}
          </button>

          <button
            onClick={() => setShowManual(!showManual)}
            style={{
              padding: '5px 12px',
              borderRadius: '6px',
              border: '1px solid',
              borderColor: showManual ? '#1f6feb' : '#30363d',
              background: showManual ? 'rgba(31,111,235,0.15)' : 'transparent',
              color: showManual ? '#58a6ff' : '#8b949e',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            + Manual
          </button>

          {onAskBooba && (
            <button
              onClick={onAskBooba}
              style={{
                padding: '5px 12px',
                borderRadius: '6px',
                border: '1px solid #30363d',
                background: 'transparent',
                color: '#8b949e',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Ask Booba
            </button>
          )}
        </div>
      </div>

      {/* ── Manual form (toggled) ── */}
      {showManual && (
        <div style={{
          marginTop: '8px',
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '8px',
          padding: '16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '10px',
        }}>
          <div>
            <label style={labelStyle}>Asset</label>
            <select value={manualAsset} onChange={(e) => setManualAsset(e.target.value)} style={selectStyle}>
              {ASSETS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {manualAsset === 'Other' && (
              <input
                value={manualCustomAsset}
                onChange={(e) => setManualCustomAsset(e.target.value)}
                placeholder="Symbol"
                style={{ ...inputStyle, marginTop: '6px' }}
              />
            )}
          </div>

          <div>
            <label style={labelStyle}>Direction</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {(['LONG', 'SHORT'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setManualDirection(d)}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: manualDirection === d ? (d === 'LONG' ? '#238636' : '#da3633') : '#30363d',
                    background: manualDirection === d ? (d === 'LONG' ? 'rgba(35,134,54,0.2)' : 'rgba(218,54,51,0.2)') : 'transparent',
                    color: manualDirection === d ? (d === 'LONG' ? '#3fb950' : '#f85149') : '#6e7681',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Entry Price *</label>
            <input value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} placeholder="79000" style={inputStyle} />
          </div>

          <div>
            <label style={labelStyle}>Target Price</label>
            <input value={manualTarget} onChange={(e) => setManualTarget(e.target.value)} placeholder="82000" style={inputStyle} />
          </div>

          <div>
            <label style={labelStyle}>Stop Price</label>
            <input value={manualStop} onChange={(e) => setManualStop(e.target.value)} placeholder="77000" style={inputStyle} />
          </div>

          <div>
            <label style={labelStyle}>Caller Name *</label>
            <input value={manualCaller} onChange={(e) => setManualCaller(e.target.value)} placeholder="AlphaTrader" style={inputStyle} />
          </div>

          <div>
            <label style={labelStyle}>Source</label>
            <select value={manualSource} onChange={(e) => setManualSource(e.target.value)} style={selectStyle}>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Channel</label>
            <input value={manualChannel} onChange={(e) => setManualChannel(e.target.value)} placeholder="alpha-calls" style={inputStyle} />
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
            <button
              onClick={handleManualSubmit}
              disabled={manualSaving}
              style={{ ...btnPrimary, opacity: manualSaving ? 0.5 : 1 }}
            >
              {manualSaving ? 'Saving…' : 'Add Signal'}
            </button>
            {manualError && <span style={{ color: '#f85149', fontSize: '13px' }}>{manualError}</span>}
          </div>
        </div>
      )}

      {/* ── Preview cards ── */}
      {previews.length > 0 && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {previews.map((card, i) => (
            <div
              key={i}
              style={{
                background: card.confirmed ? 'rgba(35,134,54,0.1)' : '#0d1117',
                border: `1px solid ${card.confirmed ? '#238636' : card.parsed ? '#30363d' : '#6e3b3b'}`,
                borderRadius: '8px',
                padding: '12px',
              }}
            >
              {card.parsed ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <span style={{
                      ...dirBadge,
                      background: card.parsed.direction === 'LONG' ? 'rgba(35,134,54,0.3)' : 'rgba(218,54,51,0.3)',
                      color: card.parsed.direction === 'LONG' ? '#3fb950' : '#f85149',
                    }}>
                      {card.parsed.direction}
                    </span>
                    <span style={{ color: '#e6edf3', fontWeight: 700, fontSize: '14px' }}>{card.parsed.asset}</span>
                    <span style={{ color: '#c9d1d9', fontSize: '13px' }}>@ ${card.parsed.entryPrice.toLocaleString()}</span>
                    {card.parsed.targetPrices && card.parsed.targetPrices.length > 1 ? (
                      card.parsed.targetPrices.map((tp, j) => (
                        <span key={j} style={{ color: '#3fb950', fontSize: '12px' }}>
                          TP{j + 1}:&nbsp;${tp.toLocaleString()}
                        </span>
                      ))
                    ) : card.parsed.targetPrice ? (
                      <span style={{ color: '#3fb950', fontSize: '12px' }}>→ ${card.parsed.targetPrice.toLocaleString()}</span>
                    ) : null}
                    {card.parsed.stopPrice && (
                      <span style={{ color: '#f85149', fontSize: '12px' }}>SL ${card.parsed.stopPrice.toLocaleString()}</span>
                    )}
                  </div>

                  {!card.confirmed && (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        value={card.callerName}
                        onChange={(e) => updatePreview(i, { callerName: e.target.value })}
                        placeholder="Caller name *"
                        style={{ ...inputStyle, width: '140px' }}
                      />
                      <select
                        value={card.source}
                        onChange={(e) => updatePreview(i, { source: e.target.value })}
                        style={selectStyle}
                      >
                        {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <input
                        value={card.channelName}
                        onChange={(e) => updatePreview(i, { channelName: e.target.value })}
                        placeholder="Channel"
                        style={{ ...inputStyle, width: '120px' }}
                      />
                      <button
                        onClick={() => handleAddSignal(i)}
                        disabled={card.saving}
                        style={{ ...btnPrimary, padding: '5px 14px', opacity: card.saving ? 0.5 : 1 }}
                      >
                        {card.saving ? 'Saving…' : 'Add Signal'}
                      </button>
                      {card.error && <span style={{ color: '#f85149', fontSize: '12px' }}>{card.error}</span>}
                    </div>
                  )}

                  {card.confirmed && (
                    <span style={{ color: '#3fb950', fontSize: '12px', fontWeight: 600 }}>Saved</span>
                  )}
                </>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#6e7681', fontSize: '12px', fontStyle: 'italic', flex: 1, marginRight: '8px' }}>
                    Not a signal: &ldquo;{card.raw.slice(0, 80)}{card.raw.length > 80 ? '…' : ''}&rdquo;
                  </span>
                  <span style={{ color: '#484f58', fontSize: '11px', whiteSpace: 'nowrap' }}>skipped</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: '6px',
  border: '1px solid #30363d',
  background: '#0d1117',
  color: '#c9d1d9',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: '#8b949e',
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '4px',
};

const btnPrimary: React.CSSProperties = {
  padding: '7px 18px',
  borderRadius: '6px',
  border: 'none',
  background: '#1f6feb',
  color: '#ffffff',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const dirBadge: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.05em',
};
