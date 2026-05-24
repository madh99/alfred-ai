'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxItem, SandboxChatItem } from '@/lib/alfred-client';
import { SandboxChatInput } from '@/components/chat/SandboxChatInput';

const STATUS_COLOR: Record<string, string> = {
  creating: 'text-amber-400 bg-amber-500/10 border-amber-500/40',
  running: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/40',
  paused: 'text-blue-400 bg-blue-500/10 border-blue-500/40',
  failed: 'text-red-400 bg-red-500/10 border-red-500/40',
  discarded: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  cleaned: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  merging: 'text-purple-400 bg-purple-500/10 border-purple-500/40',
};

const PHASE_BADGES: Record<string, string> = {
  planning: 'bg-blue-500/20 text-blue-400',
  coding: 'bg-purple-500/20 text-purple-400',
  building: 'bg-amber-500/20 text-amber-400',
  fixing: 'bg-orange-500/20 text-orange-400',
  validating: 'bg-cyan-500/20 text-cyan-400',
  committing: 'bg-indigo-500/20 text-indigo-400',
  done: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-red-500/20 text-red-400',
};

/**
 * v703 — Interactive-Chat-Mode Page (Route: /interactive?sandboxId=...).
 *
 * Layout: Chat links (40%) + Preview rechts (60%). Vollbild-Fokus-View.
 * Jede User-Message spawnt einen Project-Agent-Task im Sandbox-Worktree-cwd.
 * Live-Output via existing /api/project-agents/:id/output SSE stream.
 */
export default function InteractivePage() {
  const search = useSearchParams();
  const sandboxId = search?.get('sandboxId') ?? '';
  const { client } = useConfig();
  const [sandbox, setSandbox] = useState<SandboxItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<SandboxChatItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [liveOutput, setLiveOutput] = useState<Map<string, Array<{ ts: number; source: string; text: string }>>>(new Map());
  const esRef = useRef<EventSource | null>(null);
  const currentTaskRef = useRef<string | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  // v723 — 3-Wege-Merge-Modal (PR | Direct | Abbrechen) statt verirrendem confirm()
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  // v728 — Toolbar-Modals (Logs, Stats, ENV)
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [logsContent, setLogsContent] = useState<string>('');
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(false);
  const [statsModalOpen, setStatsModalOpen] = useState(false);
  const [statsContent, setStatsContent] = useState<{ ramMb: number | null; cpuPct: number | null; status: string | null; createdAt: string; hostPort: number | null; image: string } | null>(null);
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envReveal, setEnvReveal] = useState(false);
  const [envNewKey, setEnvNewKey] = useState('');
  const [envNewValue, setEnvNewValue] = useState('');
  const [iframeReloadKey, setIframeReloadKey] = useState(0);

  const loadSandbox = useCallback(async () => {
    if (!client || !sandboxId) return;
    try {
      const sb = await client.getSandbox(sandboxId);
      setSandbox(sb);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, sandboxId]);

  const loadChat = useCallback(async () => {
    if (!client || !sandboxId) return;
    try {
      const msgs = await client.fetchSandboxChat(sandboxId);
      setChatHistory(msgs);
    } catch (e) {
      // chat list failure is not fatal — just log
      console.warn('chat load failed', e);
    }
  }, [client, sandboxId]);

  useEffect(() => { loadSandbox(); loadChat(); }, [loadSandbox, loadChat]);

  // v717 — Auto-Refresh: schnell (2s) bei creating/merging, langsam (10s) bei running,
  // damit Status-Wechsel zu cleaned/failed/discarded sichtbar werden ohne reload.
  useEffect(() => {
    if (!sandbox) return;
    const isTransient = sandbox.status === 'creating' || sandbox.status === 'merging';
    const isLive = sandbox.status === 'running' || sandbox.status === 'paused';
    if (!isTransient && !isLive) return;
    const interval = isTransient ? 2000 : 10000;
    const t = setInterval(loadSandbox, interval);
    return () => clearInterval(t);
  }, [sandbox?.status, loadSandbox]);

  // Auto-Scroll Chat
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chatHistory, liveOutput]);

  // v720 — Robusterer SSE-Subscribe mit Auto-Reconnect bei drops
  useEffect(() => {
    const runningMsg = chatHistory.find(m => m.role === 'agent' && m.taskId && m.taskPhase !== 'done' && m.taskPhase !== 'failed');
    const taskId = runningMsg?.taskId;
    if (!taskId || !client) {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      currentTaskRef.current = null;
      return;
    }
    if (taskId === currentTaskRef.current && esRef.current && esRef.current.readyState !== EventSource.CLOSED) {
      // Same task, connection still alive → nothing to do
      return;
    }
    // Close previous stream
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    currentTaskRef.current = taskId;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (currentTaskRef.current !== taskId) return;
      const es = client.openProjectAgentOutputStream(
        taskId,
        (line) => {
          setLiveOutput(prev => {
            const next = new Map(prev);
            const existing = next.get(taskId) ?? [];
            const updated = [...existing, line];
            next.set(taskId, updated.length > 200 ? updated.slice(-200) : updated);
            return next;
          });
        },
        (history) => {
          setLiveOutput(prev => { const next = new Map(prev); next.set(taskId, history); return next; });
        },
      );
      es.addEventListener('error', () => {
        // v720 — Auto-reconnect bei drop. EventSource versucht selbst zu reconnecten bei
        // transport-errors, aber wenn Server sauber schließt → CLOSED state, kein retry.
        // Wir prüfen alle 2s ob's tot ist und re-connecten.
        if (es.readyState === EventSource.CLOSED && currentTaskRef.current === taskId) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (currentTaskRef.current === taskId) {
              esRef.current = null;
              connect();
            }
          }, 2000);
        }
      });
      esRef.current = es;
    };
    connect();
    // v720 — Watchdog: alle 10s prüfen ob SSE noch lebt; wenn nicht, neu verbinden
    const watchdog = setInterval(() => {
      const es = esRef.current;
      if (es && es.readyState === EventSource.CLOSED && currentTaskRef.current === taskId) {
        es.close();
        esRef.current = null;
        connect();
      }
    }, 10000);
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(watchdog);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [chatHistory, client]);

  // Reload chat alle 4s wenn ein agent-task läuft (für phase-update + final-text)
  useEffect(() => {
    const hasRunning = chatHistory.some(m => m.role === 'agent' && m.taskId && m.taskPhase !== 'done' && m.taskPhase !== 'failed');
    if (!hasRunning) return;
    const t = setInterval(loadChat, 4000);
    return () => clearInterval(t);
  }, [chatHistory, loadChat]);

  const previewUrl = useMemo(() => {
    if (!sandbox || sandbox.status !== 'running' || !client) return null;
    return client.buildSandboxPreviewUrl(sandbox.id);
  }, [sandbox, client]);

  async function handleSendMessage(text: string, attachments?: import('@/components/chat/SandboxChatInput').SandboxChatAttachment[]) {
    if ((!text || !text.trim()) && (!attachments || attachments.length === 0)) return;
    if (!sandbox || !client) return;
    setBusy('send'); setError(null);
    setChatInput('');
    try {
      const r = await client.sendSandboxChatMessage(sandbox.id, text, attachments);
      if (!r.ok) {
        setError(r.reason ?? 'Send failed');
      }
      await loadChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function handleDiscard() {
    if (!client || !sandbox) return;
    if (!confirm('Sandbox verwerfen? Alle Änderungen gehen verloren wenn nicht gemerged.')) return;
    setBusy('discard');
    try { await client.discardSandbox(sandbox.id); await loadSandbox(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  // v728 — Toolbar Actions
  function handleReloadIframe() { setIframeReloadKey(k => k + 1); }

  async function handleRestart() {
    if (!client || !sandbox) return;
    if (!confirm('Dev-Server neu starten? Container wird gestoppt, .next/ wird gelöscht, dann neu gestartet. Worktree-Änderungen bleiben.')) return;
    setBusy('restart'); setError(null);
    try {
      const r = await client.restartSandbox(sandbox.id);
      if (!r.ok) setError(`Restart fehlgeschlagen: ${r.reason ?? 'unknown'}`);
      await loadSandbox();
      handleReloadIframe();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function loadLogs() {
    if (!client || !sandbox) return;
    try {
      const r = await client.fetchSandboxLogs(sandbox.id, 200);
      if (r.ok && r.logs !== undefined) setLogsContent(r.logs);
      else setLogsContent(`[Fehler: ${r.reason ?? 'unknown'}]`);
    } catch (e) { setLogsContent(`[Fehler: ${e instanceof Error ? e.message : String(e)}]`); }
  }

  async function openLogsModal() { setLogsModalOpen(true); await loadLogs(); }

  useEffect(() => {
    if (!logsModalOpen || !logsAutoRefresh) return;
    const t = setInterval(loadLogs, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsModalOpen, logsAutoRefresh, sandbox?.id]);

  async function openStatsModal() {
    if (!client || !sandbox) return;
    setStatsModalOpen(true);
    try {
      const r = await client.fetchSandboxStats(sandbox.id);
      if (r.ok && r.stats) setStatsContent(r.stats);
    } catch { /* */ }
  }

  async function openEnvModal() {
    if (!client || !sandbox) return;
    setEnvModalOpen(true);
    setEnvReveal(false);
    try {
      const vars = await client.fetchEnvironmentVars(sandbox.projectId, 'sandbox', false);
      setEnvVars(vars);
    } catch { setEnvVars({}); }
  }

  async function toggleEnvReveal() {
    if (!client || !sandbox) return;
    const next = !envReveal;
    setEnvReveal(next);
    try {
      const vars = await client.fetchEnvironmentVars(sandbox.projectId, 'sandbox', next);
      setEnvVars(vars);
    } catch { /* */ }
  }

  async function addEnvVar() {
    if (!client || !sandbox || !envNewKey.trim()) return;
    const key = envNewKey.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) { setError(`Ungültiger Key "${key}" (A-Z, 0-9, _, muss mit Buchstabe beginnen)`); return; }
    try {
      const r = await client.setEnvironmentVars(sandbox.projectId, 'sandbox', { [key]: envNewValue }, false);
      if (!r.ok) { setError(`ENV-Save fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
      setEnvNewKey(''); setEnvNewValue('');
      const vars = await client.fetchEnvironmentVars(sandbox.projectId, 'sandbox', envReveal);
      setEnvVars(vars);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  // v723 — Statt verirrendem confirm(): öffnet das Merge-Modal mit echten 3 Optionen.
  function handleMerge() {
    if (!client || !sandbox) return;
    setMergeModalOpen(true);
  }

  // v723 — Wird vom Modal mit konkreter Strategy aufgerufen. Direct-Merge schickt
  // confirmDirect=true an das Backend (sonst lehnt der v723-Backend-Guard ab).
  async function executeMerge(strategy: 'pr' | 'direct') {
    if (!client || !sandbox) return;
    setMergeModalOpen(false);
    setBusy('merge');
    try {
      const r = await client.mergeSandbox(sandbox.id, {
        strategy,
        ...(strategy === 'direct' ? { confirmDirect: true } : {}),
      });
      if (r.ok) {
        if (r.prUrl) window.open(r.prUrl, '_blank');
        await loadSandbox();
      } else { setError(`Merge fehlgeschlagen: ${r.reason ?? 'unknown'}`); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  if (!sandboxId) return (
    <div className="min-h-screen bg-[#0a0a0a] text-amber-400 p-6 text-sm">
      Kein sandboxId in der URL. Erwartet: <code>/interactive?sandboxId=…</code>
    </div>
  );

  if (error && !sandbox) return (
    <div className="min-h-screen bg-[#0a0a0a] text-red-400 p-6">
      <h1 className="text-xl">Fehler</h1>
      <p className="text-sm">{error}</p>
    </div>
  );

  if (!sandbox) return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-500 p-6 text-sm">Lade Sandbox …</div>
  );

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-gray-200">
      <header className="flex items-center justify-between border-b border-[#1a1a1a] px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-gray-200">💬 Interactive · {sandbox.branchName}</span>
          <span className={`px-2 py-0.5 rounded border ${STATUS_COLOR[sandbox.status] ?? 'text-gray-400 border-gray-500/40'}`}>{sandbox.status}</span>
          <span className="text-gray-500">type: {sandbox.projectType ?? '—'} · port {sandbox.hostPort ?? '—'}</span>
        </div>
        <div className="flex gap-2">
          {sandbox.status === 'running' && (
            <>
              {/* v728 — Toolbar-Buttons */}
              <button onClick={handleReloadIframe} disabled={busy !== null} title="iframe neu laden" className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded text-[11px] disabled:opacity-50">🔄</button>
              <button onClick={handleRestart} disabled={busy !== null} title="Dev-Server restart (stop + .next/ clear + start)" className="px-2 py-1 border border-amber-500/40 text-amber-400 hover:bg-amber-500/15 rounded text-[11px] disabled:opacity-50">♻️ Restart</button>
              <button onClick={openLogsModal} disabled={busy !== null} title="Container-Logs anzeigen" className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded text-[11px] disabled:opacity-50">📜 Logs</button>
              <button onClick={openStatsModal} disabled={busy !== null} title="Container-Stats (CPU/RAM)" className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded text-[11px] disabled:opacity-50">📊 Stats</button>
              <button onClick={openEnvModal} disabled={busy !== null} title="Sandbox-ENV-Variablen verwalten" className="px-2 py-1 border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded text-[11px] disabled:opacity-50">🔐 ENV</button>
              <button onClick={handleMerge} disabled={busy !== null} className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] disabled:opacity-50">✅ Merge</button>
              <button onClick={handleDiscard} disabled={busy !== null} className="px-2 py-1 border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded text-[11px] disabled:opacity-50">✕ Discard</button>
            </>
          )}
          <button onClick={() => window.close()} className="px-2 py-1 border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded text-[11px]">Schließen</button>
        </div>
      </header>

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 text-red-400 px-4 py-1.5 text-xs">{error}</div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-[40%] flex flex-col border-r border-[#1a1a1a]">
          <div ref={chatBoxRef} className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatHistory.length === 0 && (
              <div className="text-xs text-gray-500 italic">
                Beschreibe was die Sandbox bauen/ändern soll. Jede Nachricht startet einen Project-Agent-Task im Worktree (<code className="text-gray-400">{sandbox.worktreePath.split('/').slice(-2).join('/')}</code>). Live-Preview rechts updated via HMR sobald Files geändert werden.
              </div>
            )}
            {chatHistory.map((m) => {
              const liveLines = m.taskId ? liveOutput.get(m.taskId) ?? [] : [];
              const isRunning = m.taskId && m.taskPhase && m.taskPhase !== 'done' && m.taskPhase !== 'failed';
              return (
                <div key={m.id} className={`text-xs rounded p-2 ${m.role === 'user' ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-[#111] border border-[#1f1f1f]'}`}>
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                    <span>{m.role === 'user' ? '👤 Du' : '🤖 Agent'}</span>
                    <div className="flex items-center gap-2">
                      {m.taskPhase && (
                        <span className={`px-1.5 py-0.5 rounded ${PHASE_BADGES[m.taskPhase] ?? 'bg-gray-500/20 text-gray-400'}`}>{m.taskPhase}</span>
                      )}
                      <span className="text-gray-600">{new Date(m.createdAt).toLocaleTimeString('de-AT')}</span>
                    </div>
                  </div>
                  <div className="whitespace-pre-wrap text-gray-200">{m.text}</div>
                  {isRunning && liveLines.length > 0 && (
                    <details className="mt-2" open>
                      <summary className="cursor-pointer text-[10px] text-cyan-400">▾ Live-Output ({liveLines.length})</summary>
                      <div className="mt-1 max-h-48 overflow-y-auto bg-black/30 rounded p-1.5 font-mono text-[10px] text-gray-400 whitespace-pre-wrap">
                        {liveLines.slice(-40).map((l, i) => (
                          <div key={i} className={l.source === 'stderr' ? 'text-red-300' : l.source === 'system' ? 'text-blue-300' : ''}>{l.text}</div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
          <SandboxChatInput
            onSend={handleSendMessage}
            disabled={busy === 'send' || sandbox.status !== 'running'}
          />
        </div>

        <div className="flex-1 flex flex-col">
          {previewUrl ? (
            <iframe
              key={iframeReloadKey}
              src={previewUrl}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              className="flex-1 bg-white border-0"
              title={`Sandbox Preview ${sandbox.id.slice(0, 8)}`}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-sm text-gray-500 p-6 text-center">
              {sandbox.status === 'creating' && (
                <>
                  <div className="text-3xl mb-3 animate-pulse">⏳</div>
                  <div className="text-lg text-gray-300 mb-2">Container wird vorbereitet …</div>
                  {sandbox.statusReason && (
                    <div className="text-xs text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 rounded px-3 py-2 max-w-xl">
                      {sandbox.statusReason}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-600 mt-4">
                    Beim ersten Mal: Docker-Image bauen (~1-3 min) + npm install + dev-server starten.
                    Bei späteren Sandboxes des gleichen Projekts: ~30-60s.
                  </div>
                  <div className="text-[10px] text-gray-700 mt-2 font-mono">
                    Status wird alle 2s aktualisiert.
                  </div>
                </>
              )}
              {sandbox.status === 'paused' && <div>⏸ Sandbox pausiert — Resume im Project-Chat</div>}
              {sandbox.status === 'failed' && (
                <>
                  <div className="text-3xl mb-3">⚠</div>
                  <div className="text-lg text-red-400 mb-2">Container-Start fehlgeschlagen</div>
                  <pre className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 max-w-2xl whitespace-pre-wrap text-left">{sandbox.statusReason ?? 'unknown'}</pre>
                </>
              )}
              {(sandbox.status === 'discarded' || sandbox.status === 'cleaned') && <div>✕ Sandbox entfernt</div>}
            </div>
          )}
        </div>
      </div>

      {/* v723 — 3-Wege-Merge-Modal. Ersetzt confirm() das Abbrechen still als direct-merge interpretiert hat. */}
      {mergeModalOpen && sandbox && (() => {
        const branch = sandbox.defaultBranch ?? 'main';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
            onClick={() => setMergeModalOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-lg border border-amber-500/40 bg-[#0f0f0f] p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold text-amber-400">Sandbox mergen</h2>
              <p className="mt-1 text-xs text-gray-400">
                Branch: <code className="text-amber-300">{sandbox.branchName}</code><br />
                Ziel-Branch: <code className="text-amber-300">{branch}</code>
              </p>
              <div className="mt-5 flex flex-col gap-2">
                <button
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-left text-sm text-emerald-300 hover:bg-emerald-500/20"
                  onClick={() => executeMerge('pr')}
                >
                  <div className="font-semibold">PR / Merge-Request erstellen</div>
                  <div className="text-xs text-emerald-400/70">Branch wird gepusht, Pull-/Merge-Request auf der Forge geöffnet. Reviewbar.</div>
                </button>
                <button
                  className="rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-left text-sm text-red-300 hover:bg-red-500/20"
                  onClick={() => {
                    if (confirm(`Wirklich direkt in '${branch}' pushen? Diese Aktion ist nicht über die Forge reviewbar.`)) {
                      executeMerge('direct');
                    }
                  }}
                >
                  <div className="font-semibold">Direkt in <code>{branch}</code> pushen</div>
                  <div className="text-xs text-red-400/70">Squash-Merge ohne Review. Nur für Solo-Projekte oder triviale Änderungen.</div>
                </button>
                <button
                  className="rounded border border-gray-600 bg-gray-800/40 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700/40"
                  onClick={() => setMergeModalOpen(false)}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* v728 — Logs-Modal */}
      {logsModalOpen && sandbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setLogsModalOpen(false)}>
          <div className="w-full max-w-4xl max-h-[80vh] flex flex-col rounded-lg border border-gray-500/40 bg-[#0f0f0f] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-200">📜 Container-Logs · {sandbox.id.slice(0, 8)}</h2>
              <div className="flex gap-2 items-center text-[11px]">
                <label className="flex items-center gap-1 text-gray-400">
                  <input type="checkbox" checked={logsAutoRefresh} onChange={(e) => setLogsAutoRefresh(e.target.checked)} />
                  Auto-Refresh (3s)
                </label>
                <button onClick={loadLogs} className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded">🔄</button>
                <button onClick={() => setLogsModalOpen(false)} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded">✕</button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto bg-black border border-[#1a1a1a] rounded p-2 text-[10px] text-gray-300 whitespace-pre-wrap">{logsContent || '(keine Logs)'}</pre>
          </div>
        </div>
      )}

      {/* v728 — Stats-Modal */}
      {statsModalOpen && sandbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setStatsModalOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-gray-500/40 bg-[#0f0f0f] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-200">📊 Container-Stats</h2>
              <button onClick={() => setStatsModalOpen(false)} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
            </div>
            {statsContent ? (
              <div className="space-y-1 text-xs text-gray-300">
                <div>Status: <span className="text-amber-300">{statsContent.status ?? '—'}</span></div>
                <div>CPU: <span className="text-amber-300">{statsContent.cpuPct?.toFixed(1) ?? '—'}%</span></div>
                <div>RAM: <span className="text-amber-300">{statsContent.ramMb ? `${statsContent.ramMb.toFixed(0)} MB` : '—'}</span></div>
                <div>Port: <span className="text-amber-300">{statsContent.hostPort ?? '—'}</span></div>
                <div>Image: <span className="text-amber-300">{statsContent.image}</span></div>
                <div>Created: <span className="text-amber-300">{statsContent.createdAt}</span></div>
              </div>
            ) : <div className="text-xs text-gray-500">Lädt…</div>}
          </div>
        </div>
      )}

      {/* v728 — ENV-Modal */}
      {envModalOpen && sandbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setEnvModalOpen(false)}>
          <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-purple-500/40 bg-[#0f0f0f] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-purple-300">🔐 Sandbox-ENV (stage=sandbox)</h2>
              <div className="flex gap-2 text-[11px]">
                <button onClick={toggleEnvReveal} className="px-2 py-1 border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded">{envReveal ? '🔒 Maskieren' : '👁 Zeigen'}</button>
                <button onClick={() => setEnvModalOpen(false)} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded">✕</button>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 mb-3">
              Diese ENVs werden beim nächsten Sandbox-Start als <code>.env.local</code> + Container-ENVs eingespielt. Restart der Sandbox nötig damit Änderungen wirksam werden.
            </p>
            <div className="flex-1 overflow-auto space-y-1 mb-3">
              {Object.keys(envVars).length === 0 ? (
                <div className="text-xs text-gray-500 italic">Keine ENVs gesetzt. Tipp: <code>environments scan_repo project={sandbox.projectId.slice(0, 8)}</code> im Chat zeigt benötigte Keys.</div>
              ) : (
                Object.entries(envVars).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <code className="text-amber-300 font-mono min-w-[180px]">{k}</code>
                    <code className="flex-1 text-gray-300 truncate">{v}</code>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-[#1a1a1a] pt-3">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">ENV hinzufügen / überschreiben</div>
              <div className="flex gap-2">
                <input
                  type="text" value={envNewKey} onChange={(e) => setEnvNewKey(e.target.value.toUpperCase())} placeholder="KEY (A-Z, _)"
                  className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-xs text-gray-200 font-mono"
                />
                <input
                  type="text" value={envNewValue} onChange={(e) => setEnvNewValue(e.target.value)} placeholder="Wert"
                  className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-xs text-gray-200 font-mono"
                />
                <button onClick={addEnvVar} disabled={!envNewKey.trim()} className="px-3 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-xs">+ Speichern</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
