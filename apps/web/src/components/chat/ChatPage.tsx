'use client';

import { useRef, useEffect, useMemo } from 'react';
import { ChatMessage } from './ChatMessage';
import { InputBar } from './InputBar';
import { useChat } from '@/hooks/useChat';

export function ChatPage() {
  const {
    messages, streaming, currentStatus, error,
    sendMessage, cancel, retryLast, editLastUser, clearMessages, userId,
  } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

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
    <div className="flex flex-col h-full">
      {messages.length > 0 && (
        <div className="border-b border-[#1f1f1f] px-3 md:px-4 py-2 flex items-center justify-between bg-[#0d0d0d]">
          <div className="text-[11px] text-gray-500">
            <span className="hidden md:inline">User: </span>
            <span className="font-mono text-gray-400">{userId}</span>
            <span className="text-gray-700 mx-2">·</span>
            <span>{messages.length} {messages.length === 1 ? 'Nachricht' : 'Nachrichten'}</span>
          </div>
          <button
            onClick={handleClear}
            className="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1 rounded border border-[#1f1f1f] hover:border-red-500/40"
          >Leeren</button>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 && (
            <div className="text-center text-gray-500 mt-20">
              <p className="text-4xl mb-4 font-mono font-bold text-blue-500">Alfred</p>
              <p className="text-sm">Self-hosted AI Assistant</p>
              <p className="text-xs mt-2 text-gray-600">Stelle eine Frage oder gib einen Befehl ein.</p>
              <p className="text-xs mt-4 text-gray-700">
                User: <span className="font-mono text-gray-500">{userId}</span>
                <br />
                <span className="text-gray-600">Tipp: <span className="font-mono text-gray-400">/</span> öffnet die Befehlspalette.</span>
              </p>
            </div>
          )}
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
  );
}
