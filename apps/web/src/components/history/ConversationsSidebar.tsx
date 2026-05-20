'use client';

import clsx from 'clsx';
import type { ConversationSummaryItem } from '@/lib/alfred-client';

const PLATFORM_ICONS: Record<string, string> = {
  telegram: '✈️',
  matrix: '🔷',
  api: '🌐',
  discord: '🎮',
  whatsapp: '💚',
  signal: '🔵',
};

function platformIcon(platform: string): string {
  return PLATFORM_ICONS[platform] ?? '💬';
}

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'jetzt';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 30 * 86400) return `${Math.floor(sec / 86400)}d`;
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
}

interface Props {
  conversations: ConversationSummaryItem[];
  loading: boolean;
  selectedId: string | null;
  platformFilter: string;
  platforms: readonly string[];
  onSelect: (id: string) => void;
  onPlatformChange: (p: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
}

export function ConversationsSidebar({
  conversations, loading, selectedId, platformFilter, platforms,
  onSelect, onPlatformChange, onSearch, onRefresh,
}: Props) {
  return (
    <aside className="w-80 bg-[#0d0d0d] border-r border-[#1f1f1f] flex flex-col">
      <div className="p-3 border-b border-[#1f1f1f] space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Conversations</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onSearch}
              className="text-xs text-gray-400 hover:text-blue-400 px-2 py-1 border border-[#1f1f1f] rounded hover:border-blue-500/40"
              title="Suche (Ctrl+K)"
            >🔍</button>
            <button
              onClick={onRefresh}
              className="text-xs text-gray-400 hover:text-blue-400 px-2 py-1 border border-[#1f1f1f] rounded hover:border-blue-500/40"
              title="Neu laden"
            >↻</button>
          </div>
        </div>
        <select
          value={platformFilter}
          onChange={(e) => onPlatformChange(e.target.value)}
          className="w-full text-xs bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-gray-300"
        >
          {platforms.map(p => (
            <option key={p} value={p}>{p === 'all' ? 'Alle Plattformen' : p}</option>
          ))}
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-xs text-gray-500">Lade Conversations …</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="p-4 text-xs text-gray-500">Keine Conversations gefunden.</div>
        )}
        {conversations.map(c => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={clsx(
              'w-full text-left px-3 py-2 border-b border-[#161616] hover:bg-[#161616]',
              selectedId === c.id && 'bg-blue-500/10 border-l-2 border-l-blue-500',
            )}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-gray-200 flex items-center gap-1.5">
                <span>{platformIcon(c.platform)}</span>
                <span className="truncate max-w-[140px]">{c.chatId}</span>
              </span>
              <span className="text-[10px] text-gray-500">{relativeTime(c.lastMessageAt ?? c.updatedAt)}</span>
            </div>
            {c.lastMessagePreview && (
              <div className="text-[11px] text-gray-500 mt-1 line-clamp-2">{c.lastMessagePreview}</div>
            )}
            <div className="text-[10px] text-gray-600 mt-1">
              {c.messageCount} {c.messageCount === 1 ? 'Nachricht' : 'Nachrichten'}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
