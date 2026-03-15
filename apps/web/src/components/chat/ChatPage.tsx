'use client';

import { useRef, useEffect, useMemo } from 'react';
import { ChatMessage } from './ChatMessage';
import { InputBar } from './InputBar';
import { useChat } from '@/hooks/useChat';

export function ChatPage() {
  const chatId = useMemo(() => `web-${Date.now().toString(36)}`, []);
  const { messages, streaming, currentStatus, error, sendMessage } = useChat(chatId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, currentStatus]);

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 && (
            <div className="text-center text-gray-500 mt-20">
              <p className="text-4xl mb-4 font-mono font-bold text-blue-500">Alfred</p>
              <p className="text-sm">Self-hosted AI Assistant</p>
              <p className="text-xs mt-2 text-gray-600">Stelle eine Frage oder gib einen Befehl ein.</p>
            </div>
          )}
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
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
      <InputBar onSend={sendMessage} disabled={streaming} />
    </div>
  );
}
