'use client';

/**
 * MultiSelectDropdown — a checkbox-list dropdown for multi-value filters.
 *
 * When nothing is selected shows the `label` text as "All".
 * When 1-2 items are selected shows their labels joined by ", ".
 * When 3+ items are selected shows "N selected".
 *
 * Closes on outside click.
 */

import { useEffect, useRef, useState } from 'react';

interface Option {
  value: string;
  label: string;
}

interface Props {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (selected: string[]) => void;
  minWidth?: string;
}

export default function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  minWidth = '120px',
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const buttonLabel =
    selected.length === 0
      ? 'All'
      : selected.length <= 2
      ? selected
          .map((v) => options.find((o) => o.value === v)?.label ?? v)
          .join(', ')
      : `${selected.length} selected`;

  const hasSelection = selected.length > 0;

  return (
    <div className="flex flex-col gap-1 relative" ref={ref}>
      <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">
        {label}
      </label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ minWidth }}
        className={`bg-[#21262d] border text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500 flex items-center justify-between gap-2 transition-colors ${
          hasSelection ? 'border-blue-500/60' : 'border-[#30363d]'
        }`}
      >
        <span className="truncate">{buttonLabel}</span>
        <span className="text-[10px] text-[#6e7681] shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-40 max-h-[280px] overflow-y-auto"
          style={{ minWidth }}>
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[#6e7681]">No options</div>
          ) : (
            options.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="accent-blue-500 w-3.5 h-3.5 cursor-pointer"
                />
                <span>{opt.label}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
