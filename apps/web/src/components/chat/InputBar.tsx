'use client';

import { useState, useRef, useEffect, useLayoutEffect, useMemo, type KeyboardEvent } from 'react';
import { SlashCommandPalette, type SlashCommand } from './SlashCommandPalette';

interface InputBarProps {
  onSend: (text: string) => void;
  onCancel?: () => void;
  onClear?: () => void;
  streaming?: boolean;
  initialDraft?: string;
}

const DRAFT_KEY = 'alfred-chat-draft';
const MAX_ROWS = 12;

const COMMANDS: SlashCommand[] = [
  { cmd: '/help', description: 'Zeige verfügbare Befehle' },
  { cmd: '/clear', description: 'Conversation lokal leeren' },
  { cmd: '/skills', description: 'Aktive Skills auflisten' },
  { cmd: '/usage', description: 'Token-/Kosten-Verbrauch heute' },
  { cmd: '/history', description: 'Letzte Conversations öffnen' },
  { cmd: '/dashboard', description: 'Dashboard öffnen' },
  { cmd: '/knowledge', description: 'Knowledge-Graph öffnen' },
  { cmd: '/memories', description: 'Memory-Übersicht öffnen' },
  { cmd: '/runbooks', description: 'Runbooks auflisten' },
];

function estimateTokens(text: string): number {
  // OpenAI/Claude tokenization rough heuristic: ~4 chars/token for English, German is denser, use 3.5
  return Math.ceil(text.length / 3.5);
}

export function InputBar({ onSend, onCancel, onClear, streaming, initialDraft }: InputBarProps) {
  const [text, setText] = useState(initialDraft ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);

  // Restore draft on first mount (only if no initialDraft given)
  useEffect(() => {
    if (initialDraft !== undefined) return;
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) setText(stored);
    } catch {}
  }, [initialDraft]);

  // Persist draft as user types
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }, [text]);

  // Auto-resize textarea up to MAX_ROWS
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [text]);

  const slashQuery = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const firstLine = text.split('\n')[0];
    if (firstLine.includes(' ')) return null; // already typing args after cmd
    return firstLine.toLowerCase();
  }, [text]);

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    if (slashQuery === '/') return COMMANDS;
    return COMMANDS.filter(c => c.cmd.startsWith(slashQuery));
  }, [slashQuery]);

  useEffect(() => { setPaletteIndex(0); }, [slashQuery]);

  function applyCommand(cmd: SlashCommand) {
    if (cmd.cmd === '/clear') {
      onClear?.();
      setText('');
      return;
    }
    const routes: Record<string, string> = {
      '/history': '/alfred/history/',
      '/dashboard': '/alfred/dashboard/',
      '/knowledge': '/alfred/knowledge/',
      '/memories': '/alfred/memories/',
      '/runbooks': '/alfred/runbooks/',
    };
    if (routes[cmd.cmd]) {
      window.location.href = routes[cmd.cmd];
      return;
    }
    // /help, /skills, /usage → forward as message
    onSend(cmd.cmd);
    setText('');
  }

  const handleSend = () => {
    if (!text.trim() || streaming) return;
    if (filteredCommands.length > 0 && slashQuery) {
      // If text exactly matches a command, treat as command-send via palette
      const exact = filteredCommands.find(c => c.cmd === text.trim());
      if (exact) { applyCommand(exact); return; }
    }
    onSend(text.trim());
    setText('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex(i => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = filteredCommands[paletteIndex];
        if (pick) setText(pick.cmd + ' ');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const charCount = text.length;
  const tokenCount = useMemo(() => estimateTokens(text), [text]);
  const showCounter = charCount > 0;

  return (
    <div className="border-t border-[#1f1f1f] bg-[#111111] p-3 md:p-4 relative">
      <div className="max-w-4xl mx-auto">
        <div className="relative">
          <SlashCommandPalette
            visible={filteredCommands.length > 0}
            commands={filteredCommands}
            activeIndex={paletteIndex}
            onSelect={applyCommand}
            onHoverIndex={setPaletteIndex}
          />
          <div className="flex gap-2 md:gap-3 items-end">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Nachricht an Alfred …  (/ für Befehle, Shift+Enter neue Zeile)"
              rows={1}
              className="flex-1 bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a] rounded-xl px-3 md:px-4 py-2.5 md:py-3 text-sm resize-none focus:outline-none focus:border-blue-500 placeholder-gray-500 leading-relaxed"
            />
            {streaming ? (
              <button
                onClick={onCancel}
                className="bg-red-600 hover:bg-red-700 text-white rounded-xl px-4 md:px-5 py-2.5 md:py-3 text-sm font-medium transition-colors flex items-center gap-2"
                title="Stream abbrechen"
              >
                <span className="inline-block w-2 h-2 bg-white rounded-sm" />
                <span className="hidden md:inline">Stop</span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 md:px-5 py-2.5 md:py-3 text-sm font-medium transition-colors"
              >
                Senden
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-gray-500">
            <span>
              {showCounter ? (
                <>
                  <span className="font-mono">{charCount}</span> Zeichen · ≈
                  <span className="font-mono ml-1">{tokenCount}</span> Tokens
                </>
              ) : (
                <span className="text-gray-600">Tipp: / öffnet die Befehlspalette · ↑/↓ Navigation · Enter Senden</span>
              )}
            </span>
            {streaming && (
              <span className="flex items-center gap-1.5 text-blue-400">
                <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                Alfred antwortet …
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
