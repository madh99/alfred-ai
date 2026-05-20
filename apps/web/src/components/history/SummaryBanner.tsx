'use client';

import { useState } from 'react';
import type { ConversationSummary } from '@/lib/alfred-client';

interface Props { summary: ConversationSummary }

export function SummaryBanner({ summary }: Props) {
  const [open, setOpen] = useState(true);
  if (!summary?.summary) return null;
  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-amber-300 hover:text-amber-200 flex items-center gap-2"
      >
        <span>{open ? '▼' : '▶'}</span>
        <span className="uppercase tracking-wide font-semibold">Zusammenfassung</span>
        <span className="text-amber-500/60 normal-case font-normal">
          ({summary.messageCount} Nachrichten)
        </span>
      </button>
      {open && (
        <div className="mt-2 text-sm text-amber-100/80 whitespace-pre-wrap pl-4">{summary.summary}</div>
      )}
    </div>
  );
}
