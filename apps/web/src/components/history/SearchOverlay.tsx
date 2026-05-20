'use client';

import { useEffect, useRef, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ConversationSearchResult } from '@/lib/alfred-client';

interface Props {
  onClose: () => void;
  onSelect: (r: ConversationSearchResult) => void;
}

const PLATFORM_ICONS: Record<string, string> = {
  telegram: '✈️', matrix: '🔷', api: '🌐', discord: '🎮', whatsapp: '💚', signal: '🔵',
};

export function SearchOverlay({ onClose, onSelect }: Props) {
  const { client } = useConfig();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced search
  useEffect(() => {
    if (!client || query.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const r = await client.searchConversations(query.trim(), 30);
        setResults(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(handle);
  }, [client, query]);

  function highlight(text: string, q: string): React.ReactNode {
    if (!q) return text;
    const terms = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (terms.length === 0) return text;
    const pattern = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(pattern).map((part, i) =>
      pattern.test(part) ? <mark key={i} className="bg-yellow-500/40 text-yellow-100 px-0.5">{part}</mark> : <span key={i}>{part}</span>,
    );
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-20"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-w-[90vw] max-h-[70vh] bg-[#111] border border-[#2a2a2a] rounded-xl shadow-2xl flex flex-col"
      >
        <div className="p-3 border-b border-[#1f1f1f]">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Volltextsuche über alle Conversations …"
            className="w-full bg-transparent text-gray-100 placeholder-gray-500 outline-none text-sm"
          />
          <div className="text-[10px] text-gray-600 mt-1 flex justify-between">
            <span>{loading ? 'Suche …' : results.length > 0 ? `${results.length} Treffer` : query.length >= 2 ? 'Keine Treffer' : 'min. 2 Zeichen'}</span>
            <span>Esc zum Schließen</span>
          </div>
        </div>
        {error && (
          <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border-b border-red-500/40">{error}</div>
        )}
        <div className="flex-1 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.id}
              onClick={() => onSelect(r)}
              className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] border-b border-[#161616]"
            >
              <div className="flex items-center justify-between text-[10px] text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span>{PLATFORM_ICONS[r.platform] ?? '💬'}</span>
                  <span>{r.platform} · {r.chatId}</span>
                  <span className="uppercase">{r.role}</span>
                </span>
                <span>{new Date(r.createdAt).toLocaleString('de-AT')}</span>
              </div>
              <div className="text-sm text-gray-300 mt-1 line-clamp-3">
                {highlight(r.content, query)}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
