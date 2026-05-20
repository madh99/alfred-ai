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
}

export function ConversationDetail({
  conversation, messages, summary, loading, loadingMore, hasMore, onLoadOlder, onExport,
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
            {conversation.platform} · {conversation.chatId}
          </h2>
          <p className="text-xs text-gray-500">
            {conversation.messageCount} Nachrichten · seit {new Date(conversation.createdAt).toLocaleString('de-AT')}
          </p>
        </div>
        <button
          onClick={onExport}
          className="text-xs text-gray-400 hover:text-blue-400 px-3 py-1.5 border border-[#1f1f1f] rounded hover:border-blue-500/40"
        >Export ↓</button>
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
          <div key={m.id} className={clsx('border rounded-lg p-3', ROLE_STYLES[m.role] ?? ROLE_STYLES.system)}>
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
          </div>
        ))}
      </div>
    </>
  );
}
