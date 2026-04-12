'use client';

/**
 * LiveToast — minimal toast rail for live websocket notifications
 * (new fills, closed positions). Five-second auto-dismiss is handled by
 * the parent; this component only renders.
 */

export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'warn' | 'error';
}

const COLOR_BY_KIND: Record<Toast['kind'], string> = {
  info:    'border-blue-500/40 bg-blue-900/30 text-blue-200',
  success: 'border-emerald-500/40 bg-emerald-900/30 text-emerald-200',
  warn:    'border-amber-500/40 bg-amber-900/30 text-amber-200',
  error:   'border-red-500/40 bg-red-900/30 text-red-200',
};

export default function LiveToast({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 left-6 z-[60] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg border text-sm shadow-lg backdrop-blur-sm ${COLOR_BY_KIND[t.kind]}`}
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
