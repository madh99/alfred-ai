'use client';

import { useState, useMemo } from 'react';

interface Props { raw: string }

export function ToolCallsBlock({ raw }: Props) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => {
    try { return JSON.parse(raw); } catch { return null; }
  }, [raw]);

  const calls = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);

  return (
    <div className="mt-2 border-t border-current/20 pt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] uppercase tracking-wide font-mono opacity-60 hover:opacity-100"
      >
        {open ? '▼' : '▶'} tool-calls ({calls.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {parsed === null ? (
            <pre className="text-[11px] bg-black/40 p-2 rounded overflow-x-auto">{raw}</pre>
          ) : (
            calls.map((c: unknown, i: number) => {
              const obj = c as Record<string, unknown>;
              const name = (obj?.name ?? obj?.tool ?? obj?.function) as string | undefined;
              return (
                <div key={i} className="bg-black/40 p-2 rounded">
                  {name && (
                    <div className="text-[11px] font-mono font-semibold mb-1 opacity-80">
                      {name}
                    </div>
                  )}
                  <pre className="text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-words">
{JSON.stringify(c, null, 2)}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
