'use client';

import { useRef, useEffect, useMemo, useState } from 'react';
import { ChatMessage } from './ChatMessage';
import { InputBar } from './InputBar';
import { ChatSidePanel } from './ChatSidePanel';
import { ChatWelcome } from './ChatWelcome';
import { useChat } from '@/hooks/useChat';
import { useArbeit, anfrageMeta, changeMeta } from '@/hooks/useArbeit'; // v1975

const SIDE_PANEL_KEY = 'alfred-chat-side-panel';

export function ChatPage() {
  const {
    messages, streaming, currentStatus, error,
    sendMessage, cancel, retryLast, editLastUser, clearMessages, userId, chatId, faden, nachladen,
  } = useChat();
  // v1975 — Live-Zeile: Alfred arbeitet in diesem Faden (aus Telegram, App, API) bzw. ein Change läuft
  const arbeit = useArbeit();
  const [jetzt, setJetzt] = useState(() => Date.now());
  const hierLaeuft = arbeit.anfragen.filter(a => (a.faden ?? null) === (faden ?? null) && !(streaming && a.von === chatId));
  const anderswo = arbeit.anfragen.filter(a => (a.faden ?? null) !== (faden ?? null));
  const sichtbar = hierLaeuft.length > 0 || anderswo.length > 0 || arbeit.changes.length > 0;
  useEffect(() => {
    if (!sichtbar) return;
    const t = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sichtbar]);
  // Ein Lauf in diesem Faden ist fertig → Verlauf nachladen (die Antwort steht nur auf dem Server)
  const vorherHier = useRef<string[]>([]);
  useEffect(() => {
    const ids = hierLaeuft.map(a => a.arbeit);
    if (!streaming && vorherHier.current.some(id => !ids.includes(id))) void nachladen();
    vorherHier.current = ids;
  }, [hierLaeuft.map(a => a.arbeit).join(','), streaming]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  // v657 — Reply-Kontext (gesetzt durch Reply-Button auf Hover über einer Nachricht)
  const [replyTo, setReplyTo] = useState<{ messageId?: string; text: string; from?: string } | null>(null);
  // v928 — „Mit Alfred besprechen": ?draft=<text> befüllt die Eingabezeile (z.B. von der Insights-Seite)
  const [urlDraft, setUrlDraft] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const d = new URLSearchParams(window.location.search).get('draft');
    if (d) setUrlDraft(d);
  }, []);

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
              onReply={() => setReplyTo({
                messageId: msg.id,
                text: msg.content,
                from: msg.role === 'assistant' ? 'Alfred' : 'du',
              })}
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
      {sichtbar && (
        <div className="max-w-4xl w-full mx-auto px-3 md:px-4 pb-1 space-y-1">
          {arbeit.changes.slice(0, 2).map(c => (
            <a key={c.id} href={`/alfred/vorhaben/`} className={`block rounded-lg border px-3 py-1.5 text-xs ${c.phase === 'angehalten' ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
              <div className="text-gray-200 truncate">{c.phase === 'laeuft' && c.aktiv ? '⏳' : c.phase === 'angehalten' ? '⏸' : '⌛'} Change {c.id.slice(0, 8)} · {c.titel}</div>
              <div className="text-gray-400 truncate">{changeMeta(c, jetzt)}{c.schrittTitel ? ` · ${c.schrittTitel}` : ''}</div>
              {c.phase === 'angehalten' && c.grund && <div className="text-red-300 truncate">{c.grund}</div>}
            </a>
          ))}
          {hierLaeuft.map(a => (
            <div key={a.arbeit} className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs">
              <div className="text-gray-200 truncate"><span className="animate-pulse">●</span> Alfred arbeitet in diesem Gespräch · aus {a.kanal}</div>
              <div className="text-gray-400 truncate">{a.status || a.frage.slice(0, 120)}</div>
              <div className="text-gray-500 truncate">{anfrageMeta(a, jetzt)}</div>
            </div>
          ))}
          {anderswo.slice(0, 2).map(a => (
            <a key={a.arbeit} href={a.faden ? `/alfred/chat/?faden=${encodeURIComponent(a.faden)}` : '/alfred/chat/'} className="block rounded-lg border border-[#2a2a2a] bg-[#151515] px-3 py-1 text-xs text-gray-400 truncate">
              <span className="animate-pulse">●</span> Alfred arbeitet in {a.faden ? `Faden ${a.faden}` : 'Hauptgespräch'} · {a.status || a.frage.slice(0, 80)} · {anfrageMeta(a, jetzt)}
            </a>
          ))}
        </div>
      )}
      <InputBar
        key={urlDraft ? 'url-draft' : 'default'}
        onSend={sendMessage}
        onCancel={cancel}
        onClear={clearMessages}
        streaming={streaming}
        initialDraft={urlDraft}
        replyTo={replyTo}
        onClearReplyTo={() => setReplyTo(null)}
      />
      </div>
      <ChatSidePanel
        visible={sidePanelOpen}
        onClose={() => setSidePanelOpen(false)}
      />
    </div>
  );
}
