'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxItem, SandboxStatus, SandboxStatusResponse } from '@/lib/alfred-client';

interface Props {
  projectId: string;
  projectName: string;
}

const STATUS_COLOR: Record<SandboxStatus, string> = {
  creating: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  running: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  paused: 'text-blue-400 border-blue-500/40 bg-blue-500/10',
  merging: 'text-purple-400 border-purple-500/40 bg-purple-500/10',
  discarded: 'text-gray-500 border-gray-500/40 bg-gray-500/10',
  failed: 'text-red-400 border-red-500/40 bg-red-500/10',
  cleaned: 'text-gray-500 border-gray-500/40 bg-gray-500/10',
};

function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `vor ${sec}s`;
  if (sec < 3600) return `vor ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `vor ${Math.floor(sec / 3600)}h`;
  return `vor ${Math.floor(sec / 86400)}d`;
}

/**
 * v738/v739 — Idle-Countdown: Sandbox-Manager pausiert running Sandboxes nach
 * config.idleTimeoutMin (default 30 Min). v739: liest echte Config statt hardcoded.
 */
function computeIdleCountdown(lastActiveAt: string, idleTimeoutMin: number): { text: string; warning: boolean } | null {
  try {
    const lastMs = new Date(lastActiveAt).getTime();
    if (!Number.isFinite(lastMs)) return null;
    const elapsedMin = (Date.now() - lastMs) / 60000;
    const remainingMin = idleTimeoutMin - elapsedMin;
    if (remainingMin <= 0) return { text: 'auto-Pause läuft jeden Moment', warning: true };
    if (remainingMin < 1) return { text: `auto-Pause in <1 min`, warning: true };
    if (remainingMin < 5) return { text: `auto-Pause in ~${Math.round(remainingMin)} min`, warning: true };
    if (remainingMin < idleTimeoutMin) return { text: `auto-Pause in ~${Math.round(remainingMin)} min`, warning: false };
    return null; // >= idle-timeout: nicht anzeigen (gerade erst aktiv)
  } catch { return null; }
}

/**
 * v737 — Übersicht aller Sandboxes eines Projects mit Quick-Actions.
 * Zeigt nur aktive Sandboxes (creating/running/paused/merging). Auto-Refresh alle 5s
 * wenn welche running/creating sind. Pro Sandbox: Open (für interactive → /interactive),
 * Pause/Resume, Discard, Merge.
 */
export function ProjectSandboxesView({ projectId, projectName }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // v739 — Sandbox-Status für Quota-Display + dynamischen Idle-Timeout
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [globalActiveCount, setGlobalActiveCount] = useState<number>(0);
  // v741 — Inline-Logs pro Sandbox (Map: sandboxId → logs)
  const [inlineLogs, setInlineLogs] = useState<Record<string, { loading: boolean; text: string; open: boolean }>>({});

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.listSandboxes({ projectId });
      // v740 — Failed auch anzeigen (mit Recovery-Banner). 'discarded'/'cleaned' bleiben gefiltert.
      const live = list.filter(s => ['creating', 'running', 'paused', 'merging', 'failed'].includes(s.status));
      setSandboxes(live);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => {
    if (!expanded) return;
    load();
  }, [expanded, load]);

  // v739 — Status (incl. Quota-Limits) beim Expand laden
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const [st, allSandboxes] = await Promise.all([
          client.fetchSandboxStatus().catch(() => null),
          client.listAllSandboxes().catch(() => [] as SandboxItem[]),
        ]);
        if (cancelled) return;
        setStatus(st);
        const liveGlobal = allSandboxes.filter(s => ['creating', 'running', 'paused', 'merging'].includes(s.status)).length;
        setGlobalActiveCount(liveGlobal);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [expanded, client, sandboxes]); // re-fetch wenn sandboxes-Liste sich ändert (z.B. nach create/discard)

  // Auto-refresh alle 5s wenn welche running/creating sind
  useEffect(() => {
    if (!expanded) return;
    const needsRefresh = sandboxes.some(s => s.status === 'running' || s.status === 'creating' || s.status === 'merging');
    if (!needsRefresh) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [expanded, sandboxes, load]);

  async function handlePause(id: string) {
    if (!client) return;
    setBusyId(id); setError(null);
    try { await client.pauseSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  }

  async function handleResume(id: string) {
    if (!client) return;
    setBusyId(id); setError(null);
    try { await client.resumeSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  }

  async function handleDiscard(id: string, branchName: string) {
    if (!client) return;
    if (!confirm(`Sandbox "${branchName}" verwerfen? Alle nicht-gemergten Änderungen gehen verloren.`)) return;
    setBusyId(id); setError(null);
    try { await client.discardSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  }

  // v741 — Inline-Logs für failed sandboxes lazy laden
  async function toggleLogs(sandboxId: string) {
    if (!client) return;
    const current = inlineLogs[sandboxId];
    if (current?.open) {
      setInlineLogs(prev => ({ ...prev, [sandboxId]: { ...current, open: false } }));
      return;
    }
    setInlineLogs(prev => ({ ...prev, [sandboxId]: { loading: true, text: '', open: true } }));
    try {
      const r = await client.fetchSandboxLogs(sandboxId, 100);
      setInlineLogs(prev => ({ ...prev, [sandboxId]: { loading: false, text: r.ok && r.logs ? r.logs : `[Fehler: ${r.reason ?? 'unknown'}]`, open: true } }));
    } catch (e) {
      setInlineLogs(prev => ({ ...prev, [sandboxId]: { loading: false, text: `[Fehler: ${e instanceof Error ? e.message : String(e)}]`, open: true } }));
    }
  }

  async function handleOpen(s: SandboxItem) {
    if (!client) return;
    // v744 — bei paused erst auto-resume, dann Interactive öffnen
    if (s.status === 'paused' && s.containerId) {
      setBusyId(s.id); setError(null);
      try {
        await client.resumeSandbox(s.id);
        window.location.href = `/alfred/interactive?sandboxId=${s.id}`;
        return;
      } catch (e) {
        setError(`Resume fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
        await load();
      } finally { setBusyId(null); }
      return;
    }
    if (s.containerId && s.hostPort) {
      window.location.href = `/alfred/interactive?sandboxId=${s.id}`;
    } else {
      window.location.href = `/alfred/sandboxes`;
    }
  }

  // v744 — Restart-Container für failed/running (heilt dev-server cache issues)
  async function handleRestart(s: SandboxItem) {
    if (!client) return;
    if (!confirm(`Container "${s.branchName}" neu starten? (stop → .next/ clear → start)`)) return;
    setBusyId(s.id); setError(null);
    try {
      const r = await client.restartSandbox(s.id);
      if (!r.ok) setError(`Restart fehlgeschlagen: ${r.reason ?? 'unknown'}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  }

  const runningCount = sandboxes.filter(s => s.status === 'running').length;
  const totalCount = sandboxes.length;

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>
          🧪 Sandboxes
          {totalCount > 0 && <span className="ml-2 text-xs text-emerald-400">({runningCount}/{totalCount} aktiv)</span>}
        </span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-2 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}

          <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500">
            <span>
              Lebende Sandboxes für <span className="text-gray-400">{projectName}</span>. Auto-Refresh alle 5s wenn welche laufen.
            </span>
            {/* v739 — Globale Quota-Anzeige */}
            {status && typeof status.maxParallelPerUser === 'number' && (() => {
              const max = status.maxParallelPerUser;
              const used = globalActiveCount;
              const full = used >= max;
              const warning = used >= max - 1 && !full;
              const cls = full ? 'border-red-500/40 text-red-300 bg-red-500/10'
                : warning ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                : 'border-gray-600 text-gray-400';
              return (
                <span
                  className={`px-2 py-0.5 rounded border ${cls}`}
                  title={`Global ${used} von max ${max} Sandboxes parallel (alle Projekte). Bei Limit kannst du keine neuen erstellen.`}
                >
                  Quota: {used}/{max}{full ? ' VOLL' : ''}
                </span>
              );
            })()}
          </div>

          {loading && sandboxes.length === 0 && <div className="text-gray-500 italic">Lädt…</div>}

          {!loading && sandboxes.length === 0 && (
            <div className="text-gray-500 italic">
              Keine aktiven Sandboxes. Nutze <code className="text-cyan-400">🧪 Sandbox</code> oben um eine zu starten.
            </div>
          )}

          {sandboxes.map(s => {
            const interactive = s.containerId && s.hostPort;
            const idleTimeoutMin = status?.idleTimeoutMin ?? 30;
            const idle = s.status === 'running' ? computeIdleCountdown(s.lastActiveAt, idleTimeoutMin) : null;
            const isFailed = s.status === 'failed';
            return (
              <div key={s.id} className={`rounded p-2 space-y-1 ${isFailed ? 'bg-red-500/5 border-2 border-red-500/40' : 'bg-[#0a0a0a] border border-[#1a1a1a]'}`}>
                {/* v740/v741 — Recovery-Banner für failed Sandboxes mit Inline-Logs */}
                {isFailed && (() => {
                  const logState = inlineLogs[s.id];
                  return (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-red-300 text-[11px] mb-1 flex-wrap">
                        <span className="font-semibold">❌ Sandbox gefailed</span>
                        <span className="text-gray-400">— Discard empfohlen.</span>
                        <button
                          onClick={() => toggleLogs(s.id)}
                          className="px-2 py-0.5 border border-red-500/40 text-red-300 hover:bg-red-500/15 rounded text-[10px]"
                        >
                          {logState?.open ? '🙈 Logs ausblenden' : '📜 Container-Logs anzeigen'}
                        </button>
                      </div>
                      {logState?.open && (
                        <pre className="bg-black border border-red-500/30 rounded p-2 text-[10px] text-gray-300 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                          {logState.loading ? '(lädt…)' : (logState.text || '(keine Logs)')}
                        </pre>
                      )}
                    </div>
                  );
                })()}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded border text-[10px] ${STATUS_COLOR[s.status]}`}>{s.status}</span>
                  <code className="text-amber-300 font-mono text-[11px]">{s.branchName}</code>
                  {s.projectType && <span className="text-[10px] text-gray-500">type: {s.projectType}</span>}
                  {s.hostPort && <span className="text-[10px] text-gray-500">port: {s.hostPort}</span>}
                  {idle && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${idle.warning ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-gray-600 text-gray-400'}`}
                      title={`Letzte Aktivität: ${s.lastActiveAt}\nAuto-Pause nach ${idleTimeoutMin}min Idle`}
                    >⏱ {idle.text}</span>
                  )}
                  <span className="text-[10px] text-gray-500 ml-auto">{formatRelative(s.createdAt)}</span>
                </div>

                {s.statusReason && (
                  <div className="text-[10px] text-gray-500 italic">{s.statusReason}</div>
                )}

                <div className="flex gap-1 flex-wrap pt-1">
                  {/* v744 — Öffnen auch bei paused mit auto-resume */}
                  {interactive && (s.status === 'running' || s.status === 'paused') && (
                    <button
                      onClick={() => handleOpen(s)}
                      disabled={busyId === s.id}
                      className="px-2 py-0.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded text-[10px] disabled:opacity-40"
                      title={s.status === 'paused' ? 'Erst Container resume, dann Interactive öffnen' : 'Im Interactive-Chat öffnen'}
                    >▶ Öffnen{s.status === 'paused' ? ' (resume)' : ''}</button>
                  )}
                  {s.status === 'running' && (
                    <button
                      onClick={() => handlePause(s.id)}
                      disabled={busyId === s.id}
                      className="px-2 py-0.5 border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 rounded text-[10px] disabled:opacity-40"
                    >⏸ Pause</button>
                  )}
                  {s.status === 'paused' && (
                    <button
                      onClick={() => handleResume(s.id)}
                      disabled={busyId === s.id}
                      className="px-2 py-0.5 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15 rounded text-[10px] disabled:opacity-40"
                    >▶ Resume</button>
                  )}
                  {/* v744 — Restart-Button bei failed (oder running für cache-clear) */}
                  {(s.status === 'failed' || s.status === 'running') && s.containerId && (
                    <button
                      onClick={() => handleRestart(s)}
                      disabled={busyId === s.id}
                      title={s.status === 'failed' ? 'Container neu starten — heilt oft dev-server cache' : 'Container restart + .next/ clear'}
                      className={`px-2 py-0.5 border rounded text-[10px] disabled:opacity-40 ${s.status === 'failed' ? 'border-amber-500/60 text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 font-semibold' : 'border-amber-500/40 text-amber-400 hover:bg-amber-500/15'}`}
                    >♻️ Restart</button>
                  )}
                  {(s.status === 'running' || s.status === 'paused' || s.status === 'failed') && (
                    <button
                      onClick={() => handleDiscard(s.id, s.branchName)}
                      disabled={busyId === s.id}
                      className={`px-2 py-0.5 border rounded text-[10px] disabled:opacity-40 ml-auto ${s.status === 'failed' ? 'border-red-500/60 text-red-300 bg-red-500/15 hover:bg-red-500/25 font-semibold' : 'border-red-500/40 text-red-400 hover:bg-red-500/15'}`}
                    >{s.status === 'failed' ? '🗑️ Aufräumen' : '✕ Discard'}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
