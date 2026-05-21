'use client';

import { useRef, useEffect, useMemo, useState } from 'react';
import { ChatMessage } from './ChatMessage';
import { InputBar } from './InputBar';
import { ChatSidePanel } from './ChatSidePanel';
import { ChatWelcome } from './ChatWelcome';
import { useChat } from '@/hooks/useChat';

const SIDE_PANEL_KEY = 'alfred-chat-side-panel';

export function ChatPage() {
  const {
    messages, streaming, currentStatus, error,
    sendMessage, cancel, retryLast, editLastUser, clearMessages, userId,
  } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  // Restore side-panel state from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(SIDE_PANEL_KEY);
      if (stored === '1') setSidePanelOpen(true);
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem(SIDE_PANEL_KEY, sidePanelOpen ? '1' : '0'); } catch {}
  }, [sidePanelOpen]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, currentStatus]);

  // Find last user/assistant indexes so hover-actions know which one to act on
  const { lastUserId, lastAssistantId } = useMemo(() => {
    let lu: string | undefined;
    let la: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!la && m.role === 'assistant') la = m.id;
      if (!lu && m.role === 'user') lu = m.id;
      if (lu && la) break;
    }
    return { lastUserId: lu, lastAssistantId: la };
  }, [messages]);

  function handleClear() {
    if (!messages.length) return;
    if (confirm('Lokale Conversation wirklich leeren? (Server-Historie bleibt erhalten)')) {
      clearMessages();
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
      {(messages.length > 0 || !sidePanelOpen) && (
        <div className="border-b border-[#1f1f1f] px-3 md:px-4 py-2 flex items-center justify-between bg-[#0d0d0d]">
          <div className="text-[11px] text-gray-500">
            <span className="hidden md:inline">User: </span>
            <span className="font-mono text-gray-400">{userId}</span>
            {messages.length > 0 && (
              <>
                <span className="text-gray-700 mx-2">·</span>
                <span>{messages.length} {messages.length === 1 ? 'Nachricht' : 'Nachrichten'}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSidePanelOpen(o => !o)}
              className={`text-[10px] px-2 py-1 rounded border ${
                sidePanelOpen
                  ? 'bg-blue-500/15 border-blue-500/40 text-blue-300'
                  : 'border-[#1f1f1f] text-gray-500 hover:text-blue-400 hover:border-blue-500/40'
              }`}
              title="Side-Panel (Confirmations / Reminders)"
            >📋 Panel</button>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1 rounded border border-[#1f1f1f] hover:border-red-500/40"
              >Leeren</button>
            )}
          </div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 && <ChatWelcome />}
          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              isLastUser={msg.id === lastUserId}
              isLastAssistant={msg.id === lastAssistantId}
              onRetry={retryLast}
              onEdit={editLastUser}
              streaming={streaming}
            />
          ))}
          {currentStatus && (
            <div className="flex justify-start mb-4">
              <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl px-4 py-2 text-xs text-gray-400 animate-pulse">
                {currentStatus}
              </div>
            </div>
          )}
          {error && (
            <div className="text-center text-red-400 text-sm mt-4 bg-red-500/10 rounded-lg p-3">
              {error}
            </div>
          )}
        </div>
      </div>
      <InputBar
        onSend={sendMessage}
        onCancel={cancel}
        onClear={clearMessages}
        streaming={streaming}
      />
      </div>
      <ChatSidePanel
        visible={sidePanelOpen}
        onClose={() => setSidePanelOpen(false)}
      />
    </div>
  );
}
