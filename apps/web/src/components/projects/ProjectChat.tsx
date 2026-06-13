'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectOpenItem, NoteItem, ProjectAgentSession } from '@/lib/alfred-client';
import { SessionLivePane } from '@/components/project-agents/SessionLivePane';

interface Msg { id: string; role: string; content: string; createdAt: string; }

/** v687 — Context-Ref: vom User per Toolbar/@-Mention angefügter Bezug auf Open-Item / Note / File / URL. */
interface ContextRef {
  kind: 'open_item' | 'note' | 'document' | 'file' | 'upload' | 'url';
  refId: string;
  label: string;
}

interface Props {
  projectId: string;
  projectName: string;
  /** v842 — Optional: ohne projectCwd ist der Sessions-Filter wirkungslos (zeigt alle global).
   *  Wenn gesetzt: nur Sessions deren cwd dem project.cwd entspricht. */
  projectCwd?: string;
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
export function ProjectChat({ projectId, projectName, projectCwd }: Props) {
  const { client, user } = useConfig();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // v847 — Status-Log statt überschreibendes setStatus.
  // Pre-v847 sah der User nur "Thinking..." weil jeder Status den vorherigen
  // überschrieb. Mit dem Log bleibt die ganze Timeline sichtbar.
  const [statusLog, setStatusLog] = useState<Array<import('@/lib/alfred-client').ProgressEventDto>>([]);
  const [showStatusLog, setShowStatusLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v678 — Auto-expand wenn die Sidebar mit ?chat=open navigiert hat
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return new URLSearchParams(window.location.search).get('chat') === 'open'; } catch { return false; }
  });
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  // v687 — Context-Refs State + Picker-States
  const [contextRefs, setContextRefs] = useState<ContextRef[]>([]);
  const [openItems, setOpenItems] = useState<ProjectOpenItem[]>([]);
  const [showOpenItemPicker, setShowOpenItemPicker] = useState(false);
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  // v687 — @-Mention-State
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [allNotes, setAllNotes] = useState<NoteItem[]>([]);
  // v690 — Expand-Mode + Side-Panel
  const [expandedFull, setExpandedFull] = useState(false);
  const [runningSessions, setRunningSessions] = useState<ProjectAgentSession[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectAgentSession | null>(null);
  // v890 — CLI-Wahl für Agent-Läufe aus diesem Chat. 'auto' = Projekt-Strategie
  // (preferred + Ausweichen), sonst die gewählte CLI. Ändert NUR welche CLI ein
  // project_agent/code_agent-Run nutzt — nicht ob/welcher Run gestartet wird.
  const [agentChoice, setAgentChoice] = useState<string>('auto');
  const [agentNames, setAgentNames] = useState<string[]>([]);

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

  // v687 — Beim Aufklappen Open-Items + Notes laden (für Toolbar + @-Mention)
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await client.fetchProject(projectId);
        if (!cancelled && detail) {
          const active = detail.openItems.filter(it => it.status === 'open' || it.status === 'in_progress');
          setOpenItems(active);
        }
      } catch { /* non-critical */ }
      try {
        const notes = await client.fetchNotes({ limit: 200 });
        if (!cancelled) setAllNotes(notes);
      } catch { /* non-critical */ }
      // v890 — konfigurierte CLIs für den Picker laden
      try {
        const a = await client.fetchCodeAgents();
        if (!cancelled) setAgentNames(a);
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [expanded, client, projectId]);

  // v690 — Im Expand-Mode laufende Sessions polling (alle 5s)
  // v818 P2 — auch im collapsed Mode pollen, aber langsamer (15s), damit ein
  // kleiner Running-Badge im collapsed Header sichtbar wird. User sieht so dass
  // ein Agent läuft ohne erst expandieren zu müssen. Filtert per projectId so
  // dass nur Sessions DIESES Projekts gezeigt werden (fetchProjectAgents liefert global).
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const load = async () => {
      try {
        const all = await client.fetchProjectAgents();
        if (cancelled) return;
        // v842 — Bug-Fix: vorheriger Filter hatte `|| true` und zeigte alle GLOBALEN
        // Sessions. Jetzt strict gegen projectCwd. Falls projectCwd nicht gesetzt
        // (Backward-Compat): fallback auf alte Liberalität damit nichts versteckt wird.
        const running = all.filter(s => {
          const phaseActive = s.currentPhase !== 'done' && s.currentPhase !== 'failed' && s.currentPhase !== 'aborted';
          if (!phaseActive) return false;
          if (!projectCwd) return true; // ohne cwd-Prop: alles zeigen (alter Bug, aber sichtbar)
          return s.cwd === projectCwd || s.cwd?.startsWith(projectCwd + '/');
        });
        setRunningSessions(running);
      } catch { /* non-critical */ }
    };
    load();
    // Expanded: 5s tick, Collapsed: 15s tick (Running ändert sich nicht im Sekundentakt)
    const intervalMs = expandedFull ? 5000 : 15000;
    const iv = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [expandedFull, client, projectId, projectCwd]); // v842 — projectCwd in deps

  // v690 — Wenn selectedTaskId gesetzt → die Session-Details laden
  useEffect(() => {
    if (!selectedTaskId || !client) { setSelectedSession(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const s = await client.fetchProjectAgent(selectedTaskId);
        if (!cancelled) setSelectedSession(s);
      } catch { /* non-critical */ }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedTaskId, client]);

  // v690 — Esc schließt den Expand-Mode
  useEffect(() => {
    if (!expandedFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedFull]);

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
    setStatus('⏳ Sende an Alfred…');
    setStatusLog([]); // v847 — fresh log per request
    let gotAnyResponse = false;
    // v687 — ContextRefs mitschicken
    const refsToSend = contextRefs.length > 0 ? contextRefs.map(r => ({ kind: r.kind, refId: r.refId, label: r.label })) : undefined;
    cancelRef.current = client.streamProjectMessage(projectId, text, userId, {
      onStatus: (t) => setStatus(t),
      onProgress: (evt) => {
        // v847 — strukturierter Event → in Timeline-Log einfügen
        setStatusLog(prev => [...prev, evt].slice(-50));
        setStatus(evt.text); // letzter status bleibt auch als Header
      },
      onResponse: (t) => {
        gotAnyResponse = true;
        setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, content: m.content + t } : m));
      },
      onAttachment: () => { /* not needed in project-chat */ },
      onDone: () => {
        setStreaming(false);
        setStatus(null);
        // v847 — Log bleibt sichtbar (kollabiert) damit User die Schritte review'en kann
        if (!gotAnyResponse) {
          setError('Backend hat keine Antwort gesendet. Möglicherweise wurde die Nachricht von einem anderen Cluster-Node verarbeitet oder ein Pipeline-Fehler ist aufgetreten. Schau ins Server-Log für pipeline.phase-Einträge.');
          setMessages(prev => prev.filter(m => m.id !== asstMsgId));
        }
      },
      onError: (e) => { setError(e); setStreaming(false); setStatus(null); },
    }, undefined, refsToSend, agentChoice);
    // v687 — Refs nach Send zurücksetzen
    setContextRefs([]);
  }

  // v687 — Helper-Funktionen für Refs hinzufügen/entfernen
  function addRef(ref: ContextRef) {
    setContextRefs(prev => prev.find(r => r.kind === ref.kind && r.refId === ref.refId) ? prev : [...prev, ref]);
  }
  function removeRef(idx: number) {
    setContextRefs(prev => prev.filter((_, i) => i !== idx));
  }

  // v687 — Direct-Upload via Drag&Drop ins Chat
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!client) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setError('Datei zu groß (max 25 MB).'); return; }
    setStatus(`⬆ Lade ${file.name} hoch…`);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const s = r.result as string;
          const idx = s.indexOf(',');
          resolve(idx >= 0 ? s.slice(idx + 1) : s);
        };
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const uploaded = await client.uploadFileBase64(file.name, file.type || 'application/octet-stream', base64Data);
      if (uploaded) {
        addRef({ kind: 'upload', refId: uploaded.key, label: uploaded.fileName });
      } else {
        setError('Upload fehlgeschlagen (FileStore aktiv?)');
      }
    } finally { setStatus(null); }
  }

  // v687 — @-Mention: Cursor-Position prüfen + Popup auf/zu
  function onInputChange(value: string) {
    setInput(value);
    // suche letztes @ vor cursor
    const cursor = inputRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
      const query = before.slice(at + 1);
      if (!/\s/.test(query)) {
        setMentionOpen(true);
        setMentionStart(at);
        setMentionQuery(query);
        return;
      }
    }
    setMentionOpen(false);
    setMentionStart(-1);
  }

  function applyMention(label: string, ref: ContextRef) {
    if (mentionStart < 0) return;
    const before = input.slice(0, mentionStart);
    const after = input.slice((inputRef.current?.selectionStart ?? input.length));
    setInput(`${before}@${label}${after}`);
    addRef(ref);
    setMentionOpen(false);
    setMentionStart(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
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
          {/* v818 P2 — Running-Badge auch im collapsed Mode sichtbar */}
          {runningSessions.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              🤖 {runningSessions.length} laufend
            </span>
          )}
          <span className="text-[10px] text-gray-600 font-normal">— Alfred kennt den Projekt-Kontext automatisch</span>
        </button>
      </div>
    );
  }

  // v690 — Wiederverwendbarer Chat-Body (Messages + Toolbar + Input).
  // Wird vom Default-Render und vom Expand-Mode aufgerufen.
  function renderChatBody(opts?: { fillHeight?: boolean }): React.ReactElement {
    const fill = !!opts?.fillHeight;
    return (
      <>
        <div
          ref={scrollRef}
          className={fill
            ? "bg-black/30 border border-[#2a2a2a] rounded p-2 flex-1 overflow-y-auto text-xs"
            : "bg-black/30 border border-[#2a2a2a] rounded p-2 h-72 overflow-y-auto text-xs"}
        >
          {loadingHistory && messages.length === 0 && <div className="text-gray-600 italic">Lade History…</div>}
          {!loadingHistory && messages.length === 0 && (
            <div className="text-gray-600 italic">
              <p>Frage Alfred zu diesem Projekt:</p>
              <span className="text-gray-400">• &quot;baue Feature X ein&quot;</span><br />
              <span className="text-gray-400">• &quot;deploy auf 192.168.1.96 als docker-compose user ubuntu&quot;</span><br />
              <span className="text-gray-400">• &quot;was ist der aktuelle Build-Stand?&quot;</span>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={`mb-2 ${m.role === 'user' ? 'text-blue-200' : 'text-gray-200'}`}>
              <span className="text-[10px] uppercase tracking-wider text-gray-600 mr-1">
                {m.role === 'user' ? 'du' : m.role === 'assistant' ? 'alfred' : m.role}
              </span>
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
            <div className="text-[10px] text-amber-400 italic flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-amber-400 inline-block animate-pulse" />
              <span>{status}</span>
              {statusLog.length > 0 && (
                <button
                  onClick={() => setShowStatusLog(s => !s)}
                  className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 not-italic"
                >
                  {showStatusLog ? '↑' : '↓'} {statusLog.length} Schritt{statusLog.length === 1 ? '' : 'e'}
                </button>
              )}
            </div>
          )}
          {/* v847 — Status-Log: vertikale Timeline aller Progress-Events während des Streams */}
          {statusLog.length > 0 && (status || showStatusLog) && (
            <div className={"mt-1 border-l-2 border-amber-500/20 pl-2 space-y-0.5 " + (showStatusLog ? '' : 'max-h-20 overflow-hidden')}>
              {statusLog.map((evt, i) => {
                const icon = ({thinking:'💭',tool_call:'🔧',tool_done:'✓',tool_error:'✗',status:'·'} as Record<string,string>)[evt.kind] ?? '·';
                const color = evt.kind === 'tool_error' ? 'text-red-300' : evt.kind === 'tool_done' ? 'text-emerald-300/80' : 'text-gray-400';
                const dur = evt.durationMs ? ` (${(evt.durationMs / 1000).toFixed(1)}s)` : '';
                return (
                  <div key={i} className={`text-[10px] ${color} flex items-center gap-1.5`}>
                    <span>{icon}</span>
                    {evt.tool ? <span className="text-blue-300 font-medium">{evt.tool}</span> : null}
                    <span className="truncate flex-1">{evt.text}{dur}</span>
                  </div>
                );
              })}
            </div>
          )}
          {/* v847 — Done-state: kollabierter Schritt-Trace nach Abschluss */}
          {!status && statusLog.length > 0 && (
            <details className="mt-1 text-[10px] text-gray-500" onToggle={(e) => setShowStatusLog((e.currentTarget as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer select-none hover:text-gray-300">
                ▸ {statusLog.length} Schritt{statusLog.length === 1 ? '' : 'e'} ausführen
              </summary>
              <div className="border-l-2 border-[#222] pl-2 mt-1 space-y-0.5">
                {statusLog.map((evt, i) => {
                  const icon = ({thinking:'💭',tool_call:'🔧',tool_done:'✓',tool_error:'✗',status:'·'} as Record<string,string>)[evt.kind] ?? '·';
                  const color = evt.kind === 'tool_error' ? 'text-red-300' : evt.kind === 'tool_done' ? 'text-emerald-300/80' : 'text-gray-500';
                  const dur = evt.durationMs ? ` (${(evt.durationMs / 1000).toFixed(1)}s)` : '';
                  return (
                    <div key={i} className={`${color} flex items-center gap-1.5`}>
                      <span>{icon}</span>
                      {evt.tool ? <span className="text-blue-300/70">{evt.tool}</span> : null}
                      <span className="truncate flex-1">{evt.text}{dur}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>

        {error && (
          <div className="text-[11px] text-red-400 bg-red-500/10 rounded px-2 py-1 mt-1">{error}</div>
        )}

        {/* Toolbar + Chips */}
        <div className="mt-2" onDragOver={(e) => { e.preventDefault(); }} onDrop={handleDrop}>
          <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
            <button onClick={() => setShowOpenItemPicker(true)} disabled={streaming} className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded hover:bg-amber-500/20 disabled:opacity-40" title="Open-Item">📌 Open-Item</button>
            <button onClick={() => setShowAttachmentPicker(true)} disabled={streaming} className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/30 text-blue-300 rounded hover:bg-blue-500/20 disabled:opacity-40" title="Anhang">📎 Anhang</button>
            {/* v890 — CLI-Wahl für Agent-Läufe aus diesem Chat. 'auto' = Projekt-Strategie. */}
            {agentNames.length > 0 && (
              <span className="inline-flex items-center gap-1" title="Welche CLI ein Agent-Lauf aus diesem Chat nutzt. „Automatisch“ wendet die eingestellte Projekt-CLI-Strategie an (bevorzugte CLI + Ausweichen). Beeinflusst NUR die CLI, nicht ob/welcher Lauf gestartet wird.">
                <span className="text-[10px] text-gray-500">🔀</span>
                <select
                  value={agentChoice}
                  onChange={(e) => setAgentChoice(e.target.value)}
                  disabled={streaming}
                  className="text-[10px] px-1 py-0.5 bg-[#1a1a1a] border border-purple-500/30 text-purple-300 rounded disabled:opacity-40 focus:outline-none"
                >
                  <option value="auto">Automatisch (Strategie)</option>
                  {agentNames.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </span>
            )}
            <span className="text-[10px] text-gray-600">Tipp: <code>@</code> im Text, Drag&amp;Drop für Files</span>
            {contextRefs.map((r, i) => (
              <span key={`${r.kind}-${r.refId}-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[#0d0d0d] border border-blue-500/40 text-blue-200 rounded">
                <span>{r.kind === 'open_item' ? '📌' : r.kind === 'note' ? '🔖' : r.kind === 'url' ? '🔗' : r.kind === 'document' ? '📄' : '📎'}</span>
                <span className="truncate max-w-[180px]">{r.label}</span>
                <button onClick={() => removeRef(i)} className="text-gray-500 hover:text-red-400">✕</button>
              </span>
            ))}
          </div>
        </div>

        {/* Input + @-Mention */}
        <div className="flex gap-1.5 mt-1 relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (mentionOpen && e.key === 'Escape') { setMentionOpen(false); return; }
              if (!mentionOpen && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Nachricht an Alfred zum Projekt … (Enter = senden, Shift+Enter = neue Zeile, @ = Referenz)"
            rows={2}
            disabled={streaming}
            className="flex-1 bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a] rounded px-2 py-1 text-xs resize-none focus:outline-none focus:border-blue-500 placeholder-gray-500"
          />
          {mentionOpen && (() => {
            const q = mentionQuery.toLowerCase();
            const itemMatches = openItems.filter(it => it.title.toLowerCase().includes(q)).slice(0, 6);
            const noteMatches = allNotes.filter(n => n.title.toLowerCase().includes(q)).slice(0, 4);
            if (itemMatches.length + noteMatches.length === 0) return null;
            return (
              <div className="absolute bottom-full left-0 mb-1 w-[400px] max-h-[260px] overflow-y-auto bg-[#111] border border-blue-500/40 rounded shadow-lg z-10">
                {itemMatches.length > 0 && <div className="px-2 py-1 text-[9px] uppercase text-gray-500 border-b border-[#1f1f1f]">📌 Open-Items</div>}
                {itemMatches.map(it => (
                  <button key={it.id} onClick={() => applyMention(it.title.slice(0, 30), { kind: 'open_item', refId: it.id, label: it.title.slice(0, 50) })} className="w-full text-left px-2 py-1 text-xs text-gray-200 hover:bg-blue-500/10 truncate">📌 {it.title}</button>
                ))}
                {noteMatches.length > 0 && <div className="px-2 py-1 text-[9px] uppercase text-gray-500 border-b border-[#1f1f1f]">🔖 Notes</div>}
                {noteMatches.map(n => (
                  <button key={n.id} onClick={() => applyMention(n.title.slice(0, 30), { kind: 'note', refId: n.id, label: n.title.slice(0, 50) })} className="w-full text-left px-2 py-1 text-xs text-gray-200 hover:bg-blue-500/10 truncate">🔖 {n.title}</button>
                ))}
              </div>
            );
          })()}
          {streaming ? (
            <button onClick={cancel} className="px-3 py-1 bg-red-500/15 border border-red-500/40 text-red-300 rounded text-xs hover:bg-red-500/25">Stop</button>
          ) : (
            <button onClick={send} disabled={!input.trim()} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs">Senden</button>
          )}
        </div>
      </>
    );
  }

  // v690 — Wenn expandedFull: render als Overlay mit Chat + Side-Panel
  if (expandedFull) {
    return (
      <div className="fixed inset-2 z-50 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg shadow-2xl flex flex-col" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#1f1f1f]">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
            <span>💬</span>
            <span>Projekt-Chat — {projectName}</span>
          </div>
          <div className="flex items-center gap-1">
            {/* v703 — Interactive Sandbox starten (kein Project-Agent-Run nötig) */}
            <button
              onClick={async () => {
                if (!client) return;
                if (!confirm('Neue Interactive-Sandbox für dieses Projekt starten?\n\nWird in ~1-3 min hochgefahren (Image-Build + npm install). Neuer Tab öffnet sich automatisch.')) return;
                try {
                  const slug = `interactive-${Date.now().toString(36).slice(-5)}`;
                  const sb = await client.createSandbox({ projectId, mode: 'interactive-chat', slug });
                  if (sb && sb.id) window.open(`/alfred/interactive?sandboxId=${sb.id}`, '_blank');
                } catch (e) {
                  alert('Sandbox-Create fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)));
                }
              }}
              title="Standalone Interactive-Sandbox starten — Chat mit Live-Preview, ohne Project-Agent-Session"
              className="text-[10px] text-purple-400 hover:bg-purple-500/15 px-2 py-0.5 rounded border border-purple-500/40"
            >🚀 Interactive Sandbox</button>
            <button
              onClick={loadHistory}
              disabled={loadingHistory}
              title="History neu laden"
              className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
            >↻</button>
            <button
              onClick={() => setExpandedFull(false)}
              title="Verkleinern (Esc)"
              className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
            >🗗 Verkleinern</button>
            <button
              onClick={() => { setExpandedFull(false); setExpanded(false); }}
              title="Schließen"
              className="text-gray-500 hover:text-red-400 text-lg px-1"
            >✕</button>
          </div>
        </div>

        {/* Body: 2 Spalten */}
        <div className="flex-1 grid grid-cols-[1fr_420px] gap-0 overflow-hidden">
          {/* Linke Spalte: Chat */}
          <div className="flex flex-col p-3 overflow-hidden border-r border-[#1f1f1f]">
            {renderChatBody({ fillHeight: true })}
          </div>

          {/* Rechte Spalte: Running Sessions + Live-View */}
          <div className="flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f1f1f]">
              <div className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                🤖 Running ({runningSessions.length})
              </div>
            </div>
            <div className="overflow-y-auto px-3 py-2 max-h-[40%] border-b border-[#1f1f1f]">
              {runningSessions.length === 0 && (
                <div className="text-[11px] text-gray-600 italic">Keine laufenden Sessions.</div>
              )}
              <div className="space-y-1">
                {runningSessions.map(s => {
                  const folder = s.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '?';
                  const active = s.taskId === selectedTaskId;
                  return (
                    <button
                      key={s.taskId}
                      onClick={() => setSelectedTaskId(s.taskId)}
                      className={`w-full text-left rounded px-2 py-1.5 text-[11px] transition-colors ${
                        active
                          ? 'bg-emerald-500/20 border border-emerald-500/60'
                          : 'bg-[#0d0d0d] border border-[#1f1f1f] hover:border-emerald-500/40'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[9px] uppercase px-1 py-px rounded font-mono ${active ? 'bg-emerald-500/30 text-emerald-200' : 'bg-emerald-500/15 text-emerald-300'}`}>{s.currentPhase}</span>
                        <span className="text-gray-200 flex-1 truncate">{s.goal.slice(0, 60)}</span>
                      </div>
                      <div className="text-[9px] text-gray-500 mt-0.5">{folder} · iter {s.currentIteration} · {s.totalFilesChanged} files</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {selectedSession ? (
                <SessionLivePane
                  session={selectedSession}
                  onChanged={() => { /* triggert kein Reload — polling läuft */ }}
                  compact
                  projectId={projectId}
                />
              ) : (
                <div className="text-[11px] text-gray-600 italic h-full flex items-center justify-center text-center px-4">
                  {runningSessions.length > 0
                    ? 'Klick links auf eine Session für die Live-Ansicht.'
                    : 'Sobald ein Project-Agent läuft, erscheint er hier mit Live-Output, Interject-Input und Stop-Button.'}
                </div>
              )}
            </div>
          </div>
        </div>
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
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpandedFull(true)}
            title="Vergrößern (Side-Panel mit laufenden Agents)"
            className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
          >🔲 Vergrößern</button>
          <button
            onClick={loadHistory}
            disabled={loadingHistory}
            title="History neu laden"
            className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
          >↻</button>
        </div>
      </div>

      {renderChatBody()}

      {/* v687 — Open-Item-Picker (einfaches Dropdown-Modal) */}
      {showOpenItemPicker && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setShowOpenItemPicker(false)}>
          <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-3 max-w-md w-full max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-100">📌 Open-Item referenzieren</h3>
              <button onClick={() => setShowOpenItemPicker(false)} className="text-gray-500 hover:text-red-400">✕</button>
            </div>
            {openItems.length === 0 ? (
              <div className="text-[11px] text-gray-500 italic py-3 text-center">Keine offenen Items in diesem Projekt.</div>
            ) : (
              <div className="space-y-1">
                {openItems.map(it => (
                  <button
                    key={it.id}
                    onClick={() => {
                      addRef({ kind: 'open_item', refId: it.id, label: it.title.slice(0, 50) });
                      setShowOpenItemPicker(false);
                    }}
                    className="w-full text-left bg-[#0d0d0d] border border-[#2a2a2a] hover:border-blue-500/40 rounded px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{it.priority === 'high' ? '🔴' : it.priority === 'low' ? '⚪' : '🟡'}</span>
                      <span className="text-gray-200 truncate">{it.title}</span>
                    </div>
                    {it.description && <div className="text-[10px] text-gray-500 mt-0.5 truncate">{it.description.slice(0, 80)}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* v687 — Attachment-Picker (wieder verwendet v673-Style mit 4 Tabs) */}
      {showAttachmentPicker && (
        <ChatAttachmentPicker
          onClose={() => setShowAttachmentPicker(false)}
          onPicked={(ref) => { addRef(ref); setShowAttachmentPicker(false); }}
        />
      )}
    </div>
  );
}

/** v687 — Vereinfachter Attachment-Picker für Project-Chat. 4 Quellen: Documents, Files, URL, Upload. */
function ChatAttachmentPicker({ onClose, onPicked }: {
  onClose: () => void;
  onPicked: (ref: ContextRef) => void;
}) {
  const { client } = useConfig();
  const [tab, setTab] = useState<'documents' | 'files' | 'url' | 'upload'>('documents');
  const [docs, setDocs] = useState<Array<{ id: string; filename: string }>>([]);
  const [files, setFiles] = useState<Array<{ key: string; fileName: string; size: number }>>([]);
  const [search, setSearch] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [urlLabel, setUrlLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    if (tab === 'documents' && docs.length === 0) client.fetchAvailableDocuments().then(setDocs).catch(() => {});
    if (tab === 'files' && files.length === 0) client.fetchStoredFiles().then(setFiles).catch(() => {});
  }, [client, tab, docs.length, files.length]);

  async function handleUpload(file: File) {
    if (!client) return;
    if (file.size > 25 * 1024 * 1024) { setErr('Datei zu groß (max 25 MB).'); return; }
    setUploading(true); setErr(null);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const s = r.result as string;
          const idx = s.indexOf(',');
          resolve(idx >= 0 ? s.slice(idx + 1) : s);
        };
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const uploaded = await client.uploadFileBase64(file.name, file.type || 'application/octet-stream', base64Data);
      if (!uploaded) { setErr('Upload fehlgeschlagen (FileStore aktiv?)'); return; }
      onPicked({ kind: 'upload', refId: uploaded.key, label: uploaded.fileName });
    } finally { setUploading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-3 max-w-xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-100">📎 Anhang anhängen</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-red-400">✕</button>
        </div>
        <div className="flex gap-1 border-b border-[#1f1f1f] mb-2">
          {([
            { key: 'documents', label: '📄 Documents' },
            { key: 'files', label: '📁 Files' },
            { key: 'url', label: '🔗 URL' },
            { key: 'upload', label: '⬆ Upload' },
          ] as const).map(t => (
            <button key={t.key} onClick={() => { setTab(t.key); setErr(null); }} className={`px-2 py-1 text-xs border-b-2 ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400'}`}>{t.label}</button>
          ))}
        </div>
        {err && <div className="bg-red-500/10 text-red-300 rounded px-2 py-1 text-xs mb-1">{err}</div>}
        <div className="flex-1 overflow-y-auto">
          {tab === 'documents' && (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Suchen…" className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mb-2" />
              {docs.filter(d => search === '' || d.filename.toLowerCase().includes(search.toLowerCase())).slice(0, 30).map(d => (
                <button key={d.id} onClick={() => onPicked({ kind: 'document', refId: d.id, label: d.filename })} className="w-full text-left bg-[#0d0d0d] hover:bg-blue-500/10 border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mb-1">📄 {d.filename}</button>
              ))}
              {docs.length === 0 && <div className="text-[11px] text-gray-500 italic">Keine Documents.</div>}
            </>
          )}
          {tab === 'files' && (
            <>
              {files.length === 0 && <div className="text-[11px] text-gray-500 italic">Keine Files im Store.</div>}
              {files.map(f => (
                <button key={f.key} onClick={() => onPicked({ kind: 'file', refId: f.key, label: f.fileName })} className="w-full text-left bg-[#0d0d0d] hover:bg-blue-500/10 border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mb-1">📁 {f.fileName}</button>
              ))}
            </>
          )}
          {tab === 'url' && (
            <div className="space-y-2">
              <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://…" className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
              <input value={urlLabel} onChange={(e) => setUrlLabel(e.target.value)} placeholder="Anzeige-Name (optional)" className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
              <button
                onClick={() => {
                  if (!/^https?:\/\//i.test(urlInput.trim())) { setErr('URL muss mit http(s)://'); return; }
                  onPicked({ kind: 'url', refId: urlInput.trim(), label: urlLabel.trim() || urlInput.trim().slice(0, 50) });
                }}
                disabled={!urlInput.trim()}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs"
              >Anhängen</button>
            </div>
          )}
          {tab === 'upload' && (
            <div className="space-y-2">
              <div className="text-[11px] text-gray-500">Datei auswählen (max 25 MB) — wird im FileStore gespeichert.</div>
              <input type="file" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} disabled={uploading} className="text-xs text-gray-300" />
              {uploading && <div className="text-[11px] text-blue-300 italic animate-pulse">⏳ Lade hoch…</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
