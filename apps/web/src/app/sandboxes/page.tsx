'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxItem, SandboxStatusResponse, Project, SandboxStatus } from '@/lib/alfred-client';

/** v743 — Idle-Countdown identisch zu ProjectSandboxesView */
function computeIdleCountdown(lastActiveAt: string, idleTimeoutMin: number): { text: string; warning: boolean } | null {
  try {
    const lastMs = new Date(lastActiveAt).getTime();
    if (!Number.isFinite(lastMs)) return null;
    const elapsedMin = (Date.now() - lastMs) / 60000;
    const remainingMin = idleTimeoutMin - elapsedMin;
    if (remainingMin <= 0) return { text: 'auto-Pause läuft jeden Moment', warning: true };
    if (remainingMin < 1) return { text: 'auto-Pause in <1 min', warning: true };
    if (remainingMin < 5) return { text: `auto-Pause in ~${Math.round(remainingMin)} min`, warning: true };
    if (remainingMin < idleTimeoutMin) return { text: `auto-Pause in ~${Math.round(remainingMin)} min`, warning: false };
    return null;
  } catch { return null; }
}

const STATUS_COLOR: Record<string, string> = {
  creating: 'text-amber-400 bg-amber-500/10 border-amber-500/40',
  running: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/40',
  paused: 'text-blue-400 bg-blue-500/10 border-blue-500/40',
  failed: 'text-red-400 bg-red-500/10 border-red-500/40',
  discarded: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  cleaned: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  merging: 'text-purple-400 bg-purple-500/10 border-purple-500/40',
};

/**
 * v703 — Sandboxes-Verwaltungsseite. Listet ALLE aktiven Sandboxes des Users,
 * mit Quick-Actions (Interactive öffnen, Pause/Resume, Discard) + Create-Dialog.
 */
export default function SandboxesPage() {
  const { client } = useConfig();
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([]);
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createProjectId, setCreateProjectId] = useState<string>('');
  const [createMode, setCreateMode] = useState<'sandbox' | 'sandbox-preview' | 'interactive-chat'>('interactive-chat');
  // v743 — Filter + Lazy-Daten für Create-Modal + Inline-Logs
  const [filterStatus, setFilterStatus] = useState<SandboxStatus | 'all' | 'active'>('active');
  const [filterProjectId, setFilterProjectId] = useState<string>('');
  const [createEnvStage, setCreateEnvStage] = useState<string>('sandbox');
  const [createSeedId, setCreateSeedId] = useState<string>('');
  const [createEnvStages, setCreateEnvStages] = useState<Array<{ stage: string; keyCount: number }>>([]);
  const [createSeeds, setCreateSeeds] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [inlineLogs, setInlineLogs] = useState<Record<string, { loading: boolean; text: string; open: boolean }>>({});

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [list, s, projList] = await Promise.all([
        client.listAllSandboxes(),
        client.fetchSandboxStatus(),
        client.fetchProjects().catch(() => []),
      ]);
      setSandboxes(list);
      setStatus(s);
      setProjects(projList);
      if (!createProjectId && projList.length > 0) setCreateProjectId(projList[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client, createProjectId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh: v743 erweitert um running (für Idle-Countdown live)
  useEffect(() => {
    const hasTransient = sandboxes.some(s => s.status === 'creating' || s.status === 'merging' || s.status === 'running');
    if (!hasTransient) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [sandboxes, load]);

  // v743 — Bei Create-Modal-Öffnen: ENV-Stages + Seeds für gewähltes Project lazy laden
  useEffect(() => {
    if (!showCreate || !client || !createProjectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [st, sd] = await Promise.all([
          client.fetchEnvironmentStages(createProjectId).catch(() => []),
          client.fetchDbSeeds(createProjectId).catch(() => []),
        ]);
        if (cancelled) return;
        setCreateEnvStages(st);
        setCreateSeeds(sd);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [showCreate, client, createProjectId]);

  // v743 — Inline-Logs (für failed)
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

  async function handleCreate() {
    if (!client || !createProjectId) return;
    setBusy('create'); setError(null);
    try {
      const slug = `manual-${Date.now().toString(36).slice(-5)}`;
      // v743 — ENV-Stage + DB-Seed durchreichen
      const dbSeedId = createSeedId === '' ? undefined : (createSeedId === 'none' ? null : createSeedId);
      const sb = await client.createSandbox({
        projectId: createProjectId, mode: createMode, slug,
        envStage: createEnvStage,
        dbSeedId,
      });
      setShowCreate(false);
      if (sb && sb.id && createMode === 'interactive-chat') {
        window.open(`/alfred/interactive?sandboxId=${sb.id}`, '_blank');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function handlePause(id: string) {
    if (!client) return;
    setBusy(id);
    try { await client.pauseSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleResume(id: string) {
    if (!client) return;
    setBusy(id);
    try { await client.resumeSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleDiscard(id: string, branchName: string) {
    if (!client) return;
    if (!confirm(`Sandbox verwerfen?\n\nBranch ${branchName} wird gelöscht. Alle Änderungen gehen verloren wenn nicht gemerged.`)) return;
    setBusy(id);
    try { await client.discardSandbox(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  function projectName(projectId: string): string {
    return projects.find(p => p.id === projectId)?.name?.slice(0, 50) ?? projectId.slice(0, 8);
  }

  // v743 — Gefilterte Liste + Quota-Berechnung
  const activeStatuses: SandboxStatus[] = ['creating', 'running', 'paused', 'merging', 'failed'];
  const filteredSandboxes = sandboxes.filter(sb => {
    if (filterProjectId && sb.projectId !== filterProjectId) return false;
    if (filterStatus === 'all') return true;
    if (filterStatus === 'active') return activeStatuses.includes(sb.status);
    return sb.status === filterStatus;
  });
  const globalActiveCount = sandboxes.filter(s => ['creating', 'running', 'paused', 'merging'].includes(s.status)).length;
  const uniqueProjectsInList = Array.from(new Set(sandboxes.map(s => s.projectId)));

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">📦 Sandboxes</h1>
          <p className="text-sm text-gray-500">Project-Agent Sandboxes mit Live-Preview & Interactive-Chat-Mode.</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* v743 — Quota-Display */}
          {status && typeof status.maxParallelPerUser === 'number' && (() => {
            const max = status.maxParallelPerUser;
            const used = globalActiveCount;
            const full = used >= max;
            const warning = used >= max - 1 && !full;
            const cls = full ? 'border-red-500/40 text-red-300 bg-red-500/10'
              : warning ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
              : 'border-gray-600 text-gray-400';
            return (
              <span className={`px-2 py-1 rounded border text-xs ${cls}`} title={`Global ${used} von max ${max} parallel-Sandboxes`}>
                Quota: {used}/{max}{full ? ' VOLL' : ''}
              </span>
            );
          })()}
          <button
            onClick={load}
            className="px-3 py-1.5 text-sm text-blue-400 hover:text-blue-300"
          >↻ Neu laden</button>
          <button
            onClick={() => setShowCreate(true)}
            disabled={!status?.available || (status?.maxParallelPerUser !== undefined && globalActiveCount >= status.maxParallelPerUser)}
            title={status?.available
              ? (status?.maxParallelPerUser !== undefined && globalActiveCount >= status.maxParallelPerUser
                ? `Quota voll (${globalActiveCount}/${status.maxParallelPerUser})`
                : '')
              : 'Sandbox-Feature nicht verfügbar (siehe /settings)'}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
          >+ Neue Sandbox</button>
        </div>
      </div>

      {/* v743 — Filter-Bar */}
      {sandboxes.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-gray-500">Filter:</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
            className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200"
          >
            <option value="active">Aktiv (running/paused/creating/merging/failed)</option>
            <option value="all">Alle</option>
            <option value="running">running</option>
            <option value="paused">paused</option>
            <option value="creating">creating</option>
            <option value="failed">failed</option>
            <option value="merging">merging</option>
            <option value="discarded">discarded</option>
          </select>
          <select
            value={filterProjectId}
            onChange={(e) => setFilterProjectId(e.target.value)}
            className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200"
          >
            <option value="">Alle Projekte ({uniqueProjectsInList.length})</option>
            {uniqueProjectsInList.map(pid => (
              <option key={pid} value={pid}>
                {projectName(pid)} ({sandboxes.filter(s => s.projectId === pid).length})
              </option>
            ))}
          </select>
          <span className="text-gray-500 ml-auto">
            {filteredSandboxes.length} / {sandboxes.length} angezeigt
          </span>
        </div>
      )}

      {/* Feature-Status */}
      {status && !status.available && (
        <div className="border border-amber-500/40 bg-amber-500/10 text-amber-300 rounded p-3 text-sm">
          <strong>Sandbox-Feature nicht verfügbar.</strong>{' '}
          {status.dockerAvailable === false && 'Docker nicht erreichbar. '}
          {status.worktreeBaseWritable === false && 'Worktree-Pfad nicht beschreibbar. '}
          {status.reason && `(${status.reason})`}
          {' '}Konfiguration siehe Settings-Seite.
        </div>
      )}

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-400 rounded p-2 text-xs">{error}</div>
      )}

      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {!loading && sandboxes.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-12 text-center text-gray-500">
          <div className="text-4xl mb-2">📦</div>
          <div className="text-sm">Keine Sandboxes.</div>
          <div className="text-xs mt-2 text-gray-600">Erstelle eine neue für ein Projekt oben rechts.</div>
        </div>
      )}

      {!loading && sandboxes.length > 0 && filteredSandboxes.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-6 text-center text-gray-500 text-sm">
          Keine Sandboxes passen zum Filter. <button onClick={() => { setFilterStatus('all'); setFilterProjectId(''); }} className="text-blue-400 hover:underline">Alle zeigen</button>
        </div>
      )}

      <div className="space-y-2">
        {filteredSandboxes.map(sb => {
          const previewUrl = sb.status === 'running' && client ? client.buildSandboxPreviewUrl(sb.id) : null;
          const isFailed = sb.status === 'failed';
          const idleTimeoutMin = status?.idleTimeoutMin ?? 30;
          const idle = sb.status === 'running' ? computeIdleCountdown(sb.lastActiveAt, idleTimeoutMin) : null;
          const logState = inlineLogs[sb.id];
          return (
            <div key={sb.id} className={`rounded p-3 ${isFailed ? 'border-2 border-red-500/40 bg-red-500/5' : 'border border-[#1f1f1f] bg-[#0a0a0a]'}`}>
              {isFailed && (
                <div className="flex items-center gap-2 text-red-300 text-xs mb-2 flex-wrap">
                  <span className="font-semibold">❌ Sandbox gefailed — Discard empfohlen.</span>
                  <button
                    onClick={() => toggleLogs(sb.id)}
                    className="px-2 py-0.5 border border-red-500/40 text-red-300 hover:bg-red-500/15 rounded text-[10px]"
                  >
                    {logState?.open ? '🙈 Logs ausblenden' : '📜 Container-Logs anzeigen'}
                  </button>
                </div>
              )}
              {isFailed && logState?.open && (
                <pre className="bg-black border border-red-500/30 rounded p-2 text-[10px] text-gray-300 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono mb-2">
                  {logState.loading ? '(lädt…)' : (logState.text || '(keine Logs)')}
                </pre>
              )}
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${STATUS_COLOR[sb.status] ?? 'text-gray-400 border-gray-500/40'}`}>{sb.status}</span>
                    <span className="text-xs text-gray-400">{projectName(sb.projectId)}</span>
                    {sb.projectType && <span className="text-[10px] text-gray-600">· {sb.projectType}</span>}
                    {sb.hostPort && <span className="text-[10px] text-gray-600">· port {sb.hostPort}</span>}
                    {!sb.sessionId && <span className="text-[10px] text-purple-400">· standalone</span>}
                    {idle && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${idle.warning ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-gray-600 text-gray-400'}`}
                        title={`Letzte Aktivität: ${sb.lastActiveAt}\nAuto-Pause nach ${idleTimeoutMin}min Idle`}
                      >⏱ {idle.text}</span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-gray-300 break-all">{sb.branchName}</div>
                  <div className="font-mono text-[10px] text-gray-600 break-all">{sb.worktreePath}</div>
                  <div className="text-[10px] text-gray-600 mt-1">
                    Erstellt: {new Date(sb.createdAt).toLocaleString('de-AT')}
                    {' · '} Last activity: {new Date(sb.lastActiveAt).toLocaleString('de-AT')}
                  </div>
                  {sb.statusReason && !isFailed && (
                    <div className="text-[10px] text-amber-400 mt-1">⚠ {sb.statusReason}</div>
                  )}
                </div>
                <div className="flex flex-col gap-1 items-end">
                  {previewUrl && (
                    <a
                      href={`/alfred/interactive?sandboxId=${sb.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded"
                    >💬 Interactive</a>
                  )}
                  {previewUrl && (
                    <button
                      onClick={() => window.open(previewUrl, '_blank')}
                      className="text-[10px] px-2 py-0.5 text-blue-400 hover:text-blue-300"
                    >🌐 Preview</button>
                  )}
                  <div className="flex gap-1 mt-1">
                    {sb.status === 'running' && (
                      <button onClick={() => handlePause(sb.id)} disabled={busy === sb.id} className="text-[10px] px-2 py-0.5 border border-blue-500/40 text-blue-400 hover:bg-blue-500/15 rounded disabled:opacity-50">⏸</button>
                    )}
                    {sb.status === 'paused' && (
                      <button onClick={() => handleResume(sb.id)} disabled={busy === sb.id} className="text-[10px] px-2 py-0.5 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15 rounded disabled:opacity-50">▶</button>
                    )}
                    {(sb.status === 'running' || sb.status === 'paused' || sb.status === 'failed') && (
                      <button
                        onClick={() => handleDiscard(sb.id, sb.branchName)}
                        disabled={busy === sb.id}
                        className={`text-[10px] px-2 py-0.5 border rounded disabled:opacity-50 ${sb.status === 'failed' ? 'border-red-500/60 text-red-300 bg-red-500/15 hover:bg-red-500/25 font-semibold' : 'border-red-500/40 text-red-400 hover:bg-red-500/15'}`}
                      >{sb.status === 'failed' ? '🗑️ Aufräumen' : '✕'}</button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create-Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-semibold text-gray-200">Neue Sandbox erstellen</h2>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Projekt</label>
              <select
                value={createProjectId}
                onChange={(e) => setCreateProjectId(e.target.value)}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
              >
                <option value="">— wähle Projekt —</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name.slice(0, 60)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Modus</label>
              <select
                value={createMode}
                onChange={(e) => setCreateMode(e.target.value as typeof createMode)}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
              >
                <option value="interactive-chat">Interactive Chat (Chat + Live-Preview)</option>
                <option value="sandbox-preview">Sandbox + Preview (Dev-Server + iframe)</option>
                <option value="sandbox">Sandbox-only (Worktree-Isolation, kein Container)</option>
              </select>
            </div>
            {/* v743 — ENV-Stage + DB-Seed Wahl */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">🔐 ENV-Stage</label>
              <select
                value={createEnvStage}
                onChange={(e) => setCreateEnvStage(e.target.value)}
                disabled={!createProjectId}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 disabled:opacity-50"
              >
                {Array.from(new Set(['sandbox', 'dev', 'prod', 'staging', ...createEnvStages.map(s => s.stage)])).map(s => {
                  const info = createEnvStages.find(x => x.stage === s);
                  return <option key={s} value={s}>{s}{info ? ` (${info.keyCount} Keys)` : ' (leer)'}</option>;
                })}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">💾 DB-Seed</label>
              <select
                value={createSeedId}
                onChange={(e) => setCreateSeedId(e.target.value)}
                disabled={!createProjectId}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 disabled:opacity-50"
              >
                <option value="">Project-Default verwenden</option>
                <option value="none">Leer (kein Seed)</option>
                {createSeeds.map(s => <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>)}
              </select>
            </div>
            <div className="text-[10px] text-gray-600">
              Beim ersten Mal dauert's 1-3 min (Image-Build + npm install).
              {createMode === 'interactive-chat' && ' Interactive-Tab öffnet automatisch.'}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 text-sm border border-gray-500/40 text-gray-400 rounded hover:bg-gray-500/15"
              >Abbrechen</button>
              <button
                onClick={handleCreate}
                disabled={!createProjectId || busy === 'create'}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
              >{busy === 'create' ? 'Erstelle …' : 'Erstellen'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
