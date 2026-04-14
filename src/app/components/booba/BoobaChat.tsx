'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthFetch } from '@/lib/api-client';
import { useJournalOptional } from '@/app/JournalContext';
import { useTradesFilterOptional, EMPTY_TRADES_FILTER, serializeFilterToUrl } from '@/contexts/TradesFilterContext';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** If this message contains a proposal, store the proposalId for confirm/cancel */
  proposalId?: string;
  proposalStatus?: 'pending' | 'confirmed' | 'cancelled';
}

export interface BoobaChatProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let msgCounter = 0;
function nextId(): string {
  return `msg_${++msgCounter}_${Date.now()}`;
}

/** Extract proposalId from assistant message text */
function extractProposalId(text: string): string | null {
  const match = text.match(/prop_\d+_[a-z0-9]+/);
  return match ? match[0] : null;
}

/** Check if a message looks like a proposal (contains proposal ID + asks for confirm) */
function looksLikeProposal(text: string): boolean {
  return /prop_\d+_[a-z0-9]+/.test(text) &&
    (/confirm|approve|proceed|execute/i.test(text) || /Will\s+(set|move|merge|link|annotate|tag)/i.test(text));
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BoobaChat({ isOpen, onClose }: BoobaChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const authFetch = useAuthFetch();
  const journalCtx = useJournalOptional();
  const router = useRouter();
  // Optional — only available when BoobaChat is rendered inside TradesFilterProvider
  const filterCtx = useTradesFilterOptional();

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await authFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: apiMessages,
          journalId: journalCtx?.journalId ?? undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const data = await res.json();
      const responseText = data.response || 'Sorry, I had trouble processing that.';

      const proposalId = extractProposalId(responseText);
      const isProposal = proposalId && looksLikeProposal(responseText);

      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: responseText,
        ...(isProposal ? { proposalId, proposalStatus: 'pending' } : {}),
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // Handle UI action instructions returned by the server
      if (Array.isArray(data.actions)) {
        for (const action of data.actions) {
          if (action.type === 'navigate_to') {
            const page: string = action.page ?? '';
            const tab: string | undefined = action.tab;
            const path = '/' + page;
            if (tab) {
              router.push(`${path}?tab=${tab}`);
            } else {
              router.push(path);
            }
          } else if (action.type === 'set_trades_filter') {
            const f = action.filter ?? {};
            const partial: Partial<import('@/contexts/TradesFilterContext').TradesFilter> = {};
            if (f.direction) partial.direction = f.direction.toLowerCase() as 'long' | 'short';
            if (Array.isArray(f.assets) && f.assets.length > 0) partial.assets = f.assets;
            if (Array.isArray(f.regimes) && f.regimes.length > 0) partial.regimes = f.regimes;
            if (f.pnlFilter && f.pnlFilter !== 'all') partial.pnlFilter = f.pnlFilter as 'winners' | 'losers';
            if (f.dateFrom) partial.dateFrom = f.dateFrom;
            if (f.dateTo) partial.dateTo = f.dateTo;

            if (filterCtx) {
              // Already on trades page — apply filter directly
              filterCtx.setTradesFilter(partial);
            } else {
              // Navigate to trades with filter serialised into URL
              const full = { ...EMPTY_TRADES_FILTER, ...partial };
              const params = serializeFilterToUrl(full);
              router.push('/trades?' + params.toString());
            }
          }
        }
      }
    } catch (err) {
      console.error('[BoobaChat] Error:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: "Booba is having trouble thinking. Try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [messages, loading, authFetch, journalCtx?.journalId]);

  const handleConfirm = useCallback((proposalId: string, msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, proposalStatus: 'confirmed' as const } : m,
      ),
    );
    sendMessage(`Yes, execute proposal ${proposalId}`);
  }, [sendMessage]);

  const handleCancel = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, proposalStatus: 'cancelled' as const } : m,
      ),
    );
    sendMessage('No, cancel that');
  }, [sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }, [input, sendMessage]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: '90px',
      right: '20px',
      width: '350px',
      maxHeight: '500px',
      zIndex: 10000,
      display: 'flex',
      flexDirection: 'column',
      background: '#0d1117',
      border: '1px solid #30363d',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      overflow: 'hidden',
      animation: 'booba-chat-slide-up 200ms ease-out',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid #21262d',
        background: '#161b22',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img
            src="/booba/excited.svg"
            alt="Booba"
            width={24}
            height={24}
            style={{ borderRadius: '50%' }}
          />
          <span style={{ color: '#c9d1d9', fontWeight: 600, fontSize: '14px' }}>
            Chat with Booba
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#6e7681',
            cursor: 'pointer',
            fontSize: '18px',
            padding: '0 4px',
            lineHeight: 1,
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#c9d1d9'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#6e7681'; }}
        >
          &minus;
        </button>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '300px',
        maxHeight: '380px',
      }}>
        {messages.length === 0 && (
          <div style={{
            color: '#484f58',
            fontSize: '13px',
            textAlign: 'center',
            padding: '40px 16px',
          }}>
            Ask me about your trading performance, positions, or behavioral patterns.
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{
              maxWidth: '85%',
              padding: '8px 12px',
              borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: msg.role === 'user' ? '#1f6feb' : '#21262d',
              color: '#c9d1d9',
              fontSize: '13px',
              lineHeight: '1.5',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}>
              {msg.role === 'assistant' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <img src="/booba/calm.svg" alt="" width={16} height={16} />
                  <span style={{ color: '#6e7681', fontSize: '11px', fontWeight: 600 }}>Booba</span>
                </div>
              )}
              {msg.content}

              {/* Proposal confirm/cancel buttons */}
              {msg.proposalId && msg.proposalStatus === 'pending' && (
                <div style={{
                  display: 'flex',
                  gap: '8px',
                  marginTop: '8px',
                  paddingTop: '8px',
                  borderTop: '1px solid #30363d',
                }}>
                  <button
                    onClick={() => handleConfirm(msg.proposalId!, msg.id)}
                    disabled={loading}
                    style={{
                      padding: '4px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#238636',
                      color: '#ffffff',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: loading ? 'not-allowed' : 'pointer',
                      opacity: loading ? 0.5 : 1,
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => handleCancel(msg.id)}
                    disabled={loading}
                    style={{
                      padding: '4px 12px',
                      borderRadius: '6px',
                      border: '1px solid #30363d',
                      background: 'transparent',
                      color: '#8b949e',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: loading ? 'not-allowed' : 'pointer',
                      opacity: loading ? 0.5 : 1,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {msg.proposalStatus === 'confirmed' && (
                <div style={{ color: '#3fb950', fontSize: '11px', marginTop: '4px' }}>
                  Confirmed
                </div>
              )}
              {msg.proposalStatus === 'cancelled' && (
                <div style={{ color: '#6e7681', fontSize: '11px', marginTop: '4px' }}>
                  Cancelled
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 12px',
          }}>
            <img src="/booba/calm.svg" alt="" width={16} height={16} />
            <div style={{
              display: 'flex',
              gap: '4px',
            }}>
              <span className="booba-typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="booba-typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="booba-typing-dot" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex',
        gap: '8px',
        padding: '12px',
        borderTop: '1px solid #21262d',
        background: '#161b22',
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Booba about your trading..."
          disabled={loading}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid #30363d',
            background: '#0d1117',
            color: '#c9d1d9',
            fontSize: '13px',
            outline: 'none',
          }}
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            border: 'none',
            background: loading || !input.trim() ? '#21262d' : '#1f6feb',
            color: loading || !input.trim() ? '#484f58' : '#ffffff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Send
        </button>
      </div>

      {/* Inline styles for animation */}
      <style>{`
        @keyframes booba-chat-slide-up {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes booba-typing-bounce {
          0%, 80%, 100% { transform: scale(0); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        .booba-typing-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #6e7681;
          animation: booba-typing-bounce 1.2s infinite ease-in-out;
        }
      `}</style>
    </div>
  );
}
