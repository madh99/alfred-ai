'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import type {
  ConversationSummaryItem,
  ConversationMessageItem,
  ConversationSummary,
} from '@/lib/alfred-client';
import { SummaryBanner } from './SummaryBanner';
import { ToolCallsBlock } from './ToolCallsBlock';

const ROLE_STYLES: Record<string, string> = {
  user: 'bg-blue-500/10 border-blue-500/40 text-blue-100',
  assistant: 'bg-[#1a1a1a] border-[#2a2a2a] text-gray-200',
  system: 'bg-amber-500/10 border-amber-500/40 text-amber-100 text-xs italic',
  tool: 'bg-emerald-500/10 border-emerald-500/40 text-emerald-100',
};

const ROLE_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Alfred',
  system: 'System',
  tool: 'Tool',
};

interface Props {
  conversation: ConversationSummaryItem | null;
  messages: ConversationMessageItem[];
  summary: ConversationSummary | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  onExport: () => void;
  // v644 — Branch / Replay / Continue
  onBranchAtMessage?: (messageId: string) => void;
  onReplayMessage?: (messageId: string) => void;
  onContinueInChat?: () => void;
}

export function ConversationDetail({
  conversation, messages, summary, loading, loadingMore, hasMore, onLoadOlder, onExport,
  onBranchAtMessage, onReplayMessage, onContinueInChat,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastConvId = useRef<string | null>(null);

  // Scroll to bottom on conversation change (initial load)
  useEffect(() => {
    if (!conversation) return;
    if (lastConvId.current !== conversation.id) {
      lastConvId.current = conversation.id;
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }
  }, [conversation, messages]);

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Wähle eine Conversation aus der Liste …
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-[#1f1f1f] px-4 py-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-200">
            {conversation.customLabel ?? `${conversation.platform} · ${conversation.chatId}`}
            {conversation.pinnedAt && <span className="ml-2 text-amber-400" title="Pinned">📌</span>}
            {conversation.branchedFromConversationId && <span className="ml-2 text-purple-400" title="Branched">⎇</span>}
          </h2>
          <p className="text-xs text-gray-500">
            {conversation.messageCount} Nachrichten · seit {new Date(conversation.createdAt).toLocaleString('de-AT')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {onContinueInChat && (
            <button
              onClick={onContinueInChat}
              className="text-xs text-emerald-400 hover:text-emerald-300 px-3 py-1.5 border border-emerald-500/30 rounded hover:bg-emerald-500/10"
              title="Diese Conversation im Chat fortsetzen"
            >💬 Im Chat fortsetzen</button>
          )}
          <button
            onClick={onExport}
            className="text-xs text-gray-400 hover:text-blue-400 px-3 py-1.5 border border-[#1f1f1f] rounded hover:border-blue-500/40"
          >Export ↓</button>
        </div>
      </header>
      {summary && <SummaryBanner summary={summary} />}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {hasMore && (
          <div className="text-center">
            <button
              onClick={onLoadOlder}
              disabled={loadingMore}
              className="text-xs text-gray-500 hover:text-blue-400 px-3 py-1.5 border border-[#1f1f1f] rounded disabled:opacity-50"
            >
              {loadingMore ? 'Lade älter …' : '↑ Ältere Nachrichten laden'}
            </button>
          </div>
        )}
        {loading && (
          <div className="text-center text-xs text-gray-500 py-6">Lade Nachrichten …</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-center text-xs text-gray-500 py-6">Keine Nachrichten in dieser Conversation.</div>
        )}
        {messages.map(m => (
          <div key={m.id} className={clsx('border rounded-lg p-3 group relative', ROLE_STYLES[m.role] ?? ROLE_STYLES.system)}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wide font-semibold opacity-70">
                {ROLE_LABEL[m.role] ?? m.role}
              </span>
              <span className="text-[10px] opacity-50">
                {new Date(m.createdAt).toLocaleString('de-AT')}
              </span>
            </div>
            <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
            {m.toolCalls && <ToolCallsBlock raw={m.toolCalls} />}
            {/* v644 — Hover-Actions pro Message */}
            <div className="absolute right-2 -top-3 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              {onBranchAtMessage && (
                <button
                  onClick={() => onBranchAtMessage(m.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#0d0d0d] border border-[#2a2a2a] text-purple-300 hover:bg-purple-500/15"
                  title="Ab dieser Nachricht eine neue Conversation forken"
                >⎇ Branch</button>
              )}
              {m.toolCalls && onReplayMessage && (
                <button
                  onClick={() => onReplayMessage(m.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#0d0d0d] border border-[#2a2a2a] text-emerald-300 hover:bg-emerald-500/15"
                  title="Tool-Call erneut ausführen"
                >▶ Replay</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
