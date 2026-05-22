'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Msg { id: string; role: string; content: string; createdAt: string; }

interface Props {
  projectId: string;
  projectName: string;
}

/**
 * v658 — Projekt-Chat-Pane: eigene Konversation pro Projekt mit auto-injiziertem
 * Projekt-Kontext im LLM-System-Prompt (cwd, Sessions, Open-Items, Decisions).
 *
 * Beispiel-Inputs:
 *  - "baue Feature X ein"       → LLM startet project_agent
 *  - "deploy auf 192.168.1.96"  → LLM ruft deploy mit project cwd auf
 *  - "lass uns über Y brainstormen" → LLM nutzt brainstorming-skill
 *  - "was ist der Stand?"       → Direktantwort
 */
export function ProjectChat({ projectId, projectName }: Props) {
  const { client, user } = useConfig();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // v678 — Auto-expand wenn die Sidebar mit ?chat=open navigiert hat
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return new URLSearchParams(window.location.search).get('chat') === 'open'; } catch { return false; }
  });
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const userId = user?.userId ?? 'web-user';

  const loadHistory = useCallback(async () => {
    if (!client) return;
    setLoadingHistory(true);
    try {
      const h = await client.fetchProjectChatHistory(projectId, 100);
      if (h && Array.isArray(h.messages)) {
        setMessages(h.messages);
      }
    } finally {
      setLoadingHistory(false);
    }
  }, [client, projectId]);

  // Beim Aufklappen History laden
  useEffect(() => {
    if (expanded && messages.length === 0) {
      loadHistory();
    }
  }, [expanded, messages.length, loadHistory]);

  // v678 — Beim Auto-Open (Sidebar-Navigation) zum Chat-Element scrollen damit
  // der User es sofort sieht (sonst ist es weit unten in der Projects-Detail-View)
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('chat') === 'open' && rootRef.current) {
      setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      // query-param entfernen damit Reload nicht endlos auto-scrollt
      const url = new URL(window.location.href);
      url.searchParams.delete('chat');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  // Auto-Scroll bei neuer Nachricht
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [messages, status]);

  function send() {
    if (!client || !input.trim() || streaming) return;
    const text = input.trim();
    setInput('');
    setError(null);
    // Optimistic add
    const userMsgId = `local-user-${Date.now()}`;
    const asstMsgId = `local-asst-${Date.now()}`;
    setMessages(prev => [...prev,
      { id: userMsgId, role: 'user', content: text, createdAt: new Date().toISOString() },
      { id: asstMsgId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
    ]);
    setStreaming(true);
    // v680 — Sofort einen sichtbaren Status setzen damit der User Feedback hat (selbst
    // bevor das Backend einen status-Event sendet — bei HA-Dedup-Fail sehen wir sonst nichts).
    setStatus('⏳ Sende an Alfred…');
    let gotAnyResponse = false;
    cancelRef.current = client.streamProjectMessage(projectId, text, userId, {
      onStatus: (t) => setStatus(t),
      onResponse: (t) => {
        gotAnyResponse = true;
        setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, content: m.content + t } : m));
      },
      onAttachment: () => { /* not needed in project-chat */ },
      onDone: () => {
        setStreaming(false);
        setStatus(null);
        // v680 — Wenn der Stream OHNE Antwort schließt: explizit melden statt leerer Bubble
        if (!gotAnyResponse) {
          setError('Backend hat keine Antwort gesendet. Möglicherweise wurde die Nachricht von einem anderen Cluster-Node verarbeitet oder ein Pipeline-Fehler ist aufgetreten. Schau ins Server-Log für pipeline.phase-Einträge.');
          setMessages(prev => prev.filter(m => m.id !== asstMsgId)); // leere ALFRED-Bubble entfernen
        }
      },
      onError: (e) => { setError(e); setStreaming(false); setStatus(null); },
    });
  }

  function cancel() {
    cancelRef.current?.();
    setStreaming(false);
    setStatus(null);
  }

  if (!expanded) {
    return (
      <div ref={rootRef} className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▸</span>
          <span>💬 Projekt-Chat</span>
          <span className="text-[10px] text-gray-600 font-normal">— Alfred kennt den Projekt-Kontext automatisch</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▾</span>
          <span>💬 Projekt-Chat — {projectName}</span>
        </button>
        <button
          onClick={loadHistory}
          disabled={loadingHistory}
          title="History neu laden"
          className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
        >↻</button>
      </div>

      <div
        ref={scrollRef}
        className="bg-black/30 border border-[#2a2a2a] rounded p-2 h-72 overflow-y-auto text-xs"
      >
        {loadingHistory && messages.length === 0 && <div className="text-gray-600 italic">Lade History…</div>}
        {!loadingHistory && messages.length === 0 && (
          <div className="text-gray-600 italic">
            Noch keine Nachrichten. Versuche z.B.:<br />
            <span className="text-gray-400">• "baue Login-Feature ein"</span><br />
            <span className="text-gray-400">• "lass uns über DB-Schema brainstormen"</span><br />
            <span className="text-gray-400">• "deploy auf 192.168.1.96 als docker-compose user ubuntu"</span><br />
            <span className="text-gray-400">• "was ist der aktuelle Build-Stand?"</span>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`mb-2 ${m.role === 'user' ? 'text-blue-200' : 'text-gray-200'}`}>
            <span className="text-[10px] uppercase tracking-wider text-gray-600 mr-1">
              {m.role === 'user' ? 'du' : m.role === 'assistant' ? 'alfred' : m.role}
            </span>
            {/* v680 — Animierte Pulse-Bubble während leere ALFRED-Antwort streamed */}
            {m.content
              ? <span className="whitespace-pre-wrap">{m.content}</span>
              : (streaming && m.role === 'assistant'
                ? <span className="inline-flex items-center gap-1 text-gray-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '300ms' }} />
                  </span>
                : null)}
          </div>
        ))}
        {status && (
          <div className="text-[10px] text-amber-400 italic animate-pulse flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-amber-400 inline-block" />
            <span>{status}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 rounded px-2 py-1 mt-1">{error}</div>
      )}

      <div className="flex gap-1.5 mt-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Nachricht an Alfred zum Projekt … (Enter = senden, Shift+Enter = neue Zeile)"
          rows={2}
          disabled={streaming}
          className="flex-1 bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a] rounded px-2 py-1 text-xs resize-none focus:outline-none focus:border-blue-500 placeholder-gray-500"
        />
        {streaming ? (
          <button
            onClick={cancel}
            className="px-3 py-1 bg-red-500/15 border border-red-500/40 text-red-300 rounded text-xs hover:bg-red-500/25"
          >Stop</button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs"
          >Senden</button>
        )}
      </div>
    </div>
  );
}
