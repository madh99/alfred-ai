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

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.listSandboxes({ projectId });
      // Nur "lebende" Sandboxes anzeigen
      const live = list.filter(s => ['creating', 'running', 'paused', 'merging'].includes(s.status));
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

  function handleOpen(s: SandboxItem) {
    // Interactive → Chat-Page, sonst → Sandboxes-Liste
    if (s.containerId && s.hostPort) {
      window.location.href = `/alfred/interactive?sandboxId=${s.id}`;
    } else {
      window.location.href = `/alfred/sandboxes`;
    }
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
            return (
              <div key={s.id} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded p-2 space-y-1">
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
                  {interactive && s.status === 'running' && (
                    <button
                      onClick={() => handleOpen(s)}
                      className="px-2 py-0.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded text-[10px]"
                      title="Im Interactive-Chat öffnen"
                    >▶ Öffnen</button>
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
                  {(s.status === 'running' || s.status === 'paused') && (
                    <button
                      onClick={() => handleDiscard(s.id, s.branchName)}
                      disabled={busyId === s.id}
                      className="px-2 py-0.5 border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded text-[10px] disabled:opacity-40 ml-auto"
                    >✕ Discard</button>
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
