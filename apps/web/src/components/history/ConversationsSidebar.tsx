'use client';

import { useState } from 'react';
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
  sortBy: string;
  dateRange: string;
  selectedIds: Set<string>;
  bulkMode: boolean;
  onSelect: (id: string) => void;
  onPlatformChange: (p: string) => void;
  onSortChange: (s: string) => void;
  onDateRangeChange: (d: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onToggleBulkMode: () => void;
  onToggleSelect: (id: string) => void;
  onBulkExport: () => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onContinueInChat: (id: string) => void;
}

export function ConversationsSidebar({
  conversations, loading, selectedId, platformFilter, platforms, sortBy, dateRange,
  selectedIds, bulkMode,
  onSelect, onPlatformChange, onSortChange, onDateRangeChange,
  onSearch, onRefresh, onLoadMore, hasMore, loadingMore,
  onToggleBulkMode, onToggleSelect, onBulkExport,
  onPin, onRename, onDelete, onContinueInChat,
}: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');

  function startRename(c: ConversationSummaryItem) {
    setRenamingId(c.id);
    setRenameInput(c.customLabel ?? '');
  }
  function commitRename() {
    if (!renamingId) return;
    onRename(renamingId, renameInput.trim());
    setRenamingId(null);
    setRenameInput('');
  }

  return (
    <aside className="w-80 bg-[#0d0d0d] border-r border-[#1f1f1f] flex flex-col">
      <div className="p-3 border-b border-[#1f1f1f] space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Conversations</h2>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onToggleBulkMode}
              className={clsx(
                'text-xs px-2 py-1 border rounded',
                bulkMode ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'text-gray-400 hover:text-blue-400 border-[#1f1f1f]',
              )}
              title="Bulk-Auswahl"
            >☑</button>
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
        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={platformFilter}
            onChange={(e) => onPlatformChange(e.target.value)}
            className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-gray-300"
          >
            {platforms.map(p => (
              <option key={p} value={p}>{p === 'all' ? 'Alle Plattformen' : p}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-gray-300"
          >
            <option value="pinned_first">Pinned zuerst</option>
            <option value="updated">Zuletzt aktiv</option>
            <option value="created">Neueste</option>
            <option value="message_count_desc">Längste</option>
          </select>
        </div>
        <select
          value={dateRange}
          onChange={(e) => onDateRangeChange(e.target.value)}
          className="w-full text-xs bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-gray-300"
        >
          <option value="all">Alle Zeit</option>
          <option value="today">Heute</option>
          <option value="week">Letzte 7d</option>
          <option value="month">Letzte 30d</option>
          <option value="quarter">Letzte 90d</option>
          <option value="year">Letztes Jahr</option>
        </select>
        {bulkMode && selectedIds.size > 0 && (
          <div className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 rounded px-2 py-1.5 text-xs">
            <span className="text-blue-200">{selectedIds.size} ausgewählt</span>
            <div className="flex-1" />
            <button onClick={onBulkExport} className="px-2 py-0.5 text-[10px] bg-blue-600 hover:bg-blue-500 text-white rounded">📥 Export</button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-xs text-gray-500">Lade Conversations …</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="p-4 text-xs text-gray-500">Keine Conversations gefunden.</div>
        )}
        {conversations.map(c => {
          const isSelected = selectedId === c.id;
          const isMultiSelected = selectedIds.has(c.id);
          const isHovered = hoverId === c.id;
          const isRenaming = renamingId === c.id;
          const displayName = c.customLabel ?? c.chatId;
          return (
            <div
              key={c.id}
              onMouseEnter={() => setHoverId(c.id)}
              onMouseLeave={() => setHoverId(prev => prev === c.id ? null : prev)}
              className={clsx(
                'w-full text-left px-3 py-2 border-b border-[#161616] hover:bg-[#161616] cursor-pointer',
                isSelected && 'bg-blue-500/10 border-l-2 border-l-blue-500',
                isMultiSelected && 'bg-blue-500/15',
              )}
              onClick={() => {
                if (bulkMode) onToggleSelect(c.id);
                else onSelect(c.id);
              }}
            >
              <div className="flex items-center justify-between text-xs gap-1">
                {bulkMode && (
                  <input
                    type="checkbox"
                    checked={isMultiSelected}
                    onChange={() => onToggleSelect(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="mr-1"
                  />
                )}
                {c.pinnedAt && <span className="text-amber-400" title="Pinned">📌</span>}
                <span className="font-medium text-gray-200 flex items-center gap-1.5 flex-1 min-w-0">
                  <span>{platformIcon(c.platform)}</span>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') { setRenamingId(null); setRenameInput(''); }
                      }}
                      onBlur={commitRename}
                      placeholder={c.chatId}
                      className="flex-1 bg-[#0a0a0a] border border-blue-500/40 rounded px-1 py-0.5 text-xs text-gray-200"
                    />
                  ) : (
                    <span className="truncate max-w-[140px]" title={c.chatId}>{displayName}</span>
                  )}
                </span>
                <span className="text-[10px] text-gray-500">{relativeTime(c.lastMessageAt ?? c.updatedAt)}</span>
              </div>
              {c.lastMessagePreview && !isRenaming && (
                <div className="text-[11px] text-gray-500 mt-1 line-clamp-2">{c.lastMessagePreview}</div>
              )}
              <div className="flex items-center justify-between mt-1">
                <div className="text-[10px] text-gray-600">
                  {c.messageCount} {c.messageCount === 1 ? 'Nachricht' : 'Nachrichten'}
                  {c.branchedFromConversationId && <span className="ml-1 text-purple-400" title="Branch">⎇</span>}
                </div>
                {/* Hover-Actions */}
                {isHovered && !isRenaming && !bulkMode && (
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); onPin(c.id, !c.pinnedAt); }}
                      className="text-[11px] px-1 text-gray-400 hover:text-amber-400"
                      title={c.pinnedAt ? 'Unpin' : 'Pin'}
                    >{c.pinnedAt ? '📌' : '📍'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(c); }}
                      className="text-[11px] px-1 text-gray-400 hover:text-blue-400"
                      title="Umbenennen"
                    >✎</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onContinueInChat(c.id); }}
                      className="text-[11px] px-1 text-gray-400 hover:text-emerald-400"
                      title="Im Chat fortsetzen"
                    >💬</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                      className="text-[11px] px-1 text-gray-400 hover:text-red-400"
                      title="Löschen"
                    >✕</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full text-xs text-gray-400 hover:text-blue-400 py-3 disabled:opacity-50"
          >{loadingMore ? 'Lade …' : '↓ Mehr laden'}</button>
        )}
      </div>
    </aside>
  );
}
