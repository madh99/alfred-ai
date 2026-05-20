'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';

export interface SlashCommand {
  cmd: string;
  description: string;
  /** Action: pass `null` to keep current text, return new text to replace it, or invoke side-effect and return ''. */
  apply?: () => string | null;
}

interface Props {
  visible: boolean;
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHoverIndex: (i: number) => void;
}

export function SlashCommandPalette({ visible, commands, activeIndex, onSelect, onHoverIndex }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-i="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, visible]);

  if (!visible || commands.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-y-auto bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl shadow-xl"
    >
      {commands.map((c, i) => (
        <button
          key={c.cmd}
          data-i={i}
          onClick={() => onSelect(c)}
          onMouseEnter={() => onHoverIndex(i)}
          className={clsx(
            'w-full text-left px-3 py-2 flex items-baseline gap-3 text-sm',
            i === activeIndex ? 'bg-blue-500/15' : 'hover:bg-[#222]',
          )}
        >
          <span className="font-mono text-blue-400">{c.cmd}</span>
          <span className="text-xs text-gray-400">{c.description}</span>
        </button>
      ))}
      <div className="px-3 py-1 text-[10px] text-gray-500 border-t border-[#2a2a2a]">
        ↑↓ Auswählen · Enter Übernehmen · Esc Schließen
      </div>
    </div>
  );
}
