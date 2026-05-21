'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { Project, ClusterShareStatus, MovePreflightResult } from '@/lib/alfred-client';

interface Props {
  project: Project;
  onMoved?: () => void;
}

function statusIcon(p: { passed: boolean }): string { return p.passed ? '✓' : '✗'; }
function relTime(iso?: string): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const sec = Math.floor(Math.abs(ms) / 1000);
  const prefix = ms > 0 ? 'in ' : 'vor ';
  if (sec < 60) return `${prefix}${sec}s`;
  if (sec < 3600) return `${prefix}${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${prefix}${Math.floor(sec / 3600)}h`;
  return `${prefix}${Math.floor(sec / 86400)}d`;
}

/**
 * v665b — Storage-Section: zeigt aktuelles cwd/storage_type, Lock-Status, und
 * öffnet ein Move-Modal für storage_type / share-Wechsel.
 */
export function ProjectStorageView({ project, onMoved }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showMove, setShowMove] = useState(false);

  const storage = project.storageType ?? 'local';
  const locked = project.lockedByNodeId && project.lockedUntil
    && new Date(project.lockedUntil).getTime() > Date.now();

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200">
          <span>▸</span>
          <span>📦 Storage</span>
          <span className="text-[10px] text-gray-500 font-mono">
            {storage === 'shared' ? `shared@${project.shareId}` : `local@${project.nodeId ?? 'single'}`}
          </span>
          {locked && <span className="text-[10px] text-amber-400">🔒 locked</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setExpanded(false)} className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200">
          <span>▾</span>
          <span>📦 Storage</span>
        </button>
        <button onClick={() => setShowMove(true)} className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded">
          📤 Move…
        </button>
      </div>

      <div className="bg-[#0f0f0f] border border-[#222] rounded p-3 text-xs space-y-1.5">
        <div className="flex gap-2">
          <span className="text-gray-500 w-24">Storage-Typ:</span>
          <span className={storage === 'shared' ? 'text-blue-300' : 'text-emerald-300'}>{storage}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-500 w-24">Pfad:</span>
          <code className="text-gray-200 font-mono">{project.cwd ?? '—'}</code>
        </div>
        {storage === 'shared' && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Share:</span>
            <code className="text-blue-300 font-mono">{project.shareId ?? '?'}</code>
          </div>
        )}
        {storage === 'local' && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Node:</span>
            <code className="text-emerald-300 font-mono">{project.nodeId ?? '(noch ungebunden)'}</code>
          </div>
        )}
        {locked && (
          <div className="flex gap-2 pt-1 border-t border-[#222]">
            <span className="text-gray-500 w-24">🔒 Lock:</span>
            <span className="text-amber-300">
              node "{project.lockedByNodeId}" bis {relTime(project.lockedUntil)}
            </span>
          </div>
        )}
      </div>

      {showMove && (
        <MoveModal
          project={project}
          onClose={() => setShowMove(false)}
          onMoved={() => { setShowMove(false); onMoved?.(); }}
        />
      )}
    </div>
  );
}

function MoveModal({ project, onClose, onMoved }: { project: Project; onClose: () => void; onMoved: () => void }) {
  const { client } = useConfig();
  const [shares, setShares] = useState<ClusterShareStatus[]>([]);
  const [loadingShares, setLoadingShares] = useState(true);
  const [targetType, setTargetType] = useState<'local' | 'shared'>(project.storageType === 'shared' ? 'local' : 'shared');
  const [targetShare, setTargetShare] = useState<string>('');
  const [keepSource, setKeepSource] = useState(false);
  const [preflight, setPreflight] = useState<MovePreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!client) return;
    setLoadingShares(true);
    client.fetchClusterShares()
      .then(list => {
        setShares(list);
        const usable = list.find(s => s.available && (s.writable || s.readOnly));
        if (usable && !targetShare) setTargetShare(usable.id);
      })
      .finally(() => setLoadingShares(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const runPreflight = useCallback(async () => {
    if (!client) return;
    if (targetType === 'shared' && !targetShare) return;
    setChecking(true);
    setPreflight(null);
    try {
      const r = await client.projectMovePreflight(project.id, {
        storageType: targetType,
        shareId: targetType === 'shared' ? targetShare : undefined,
      });
      setPreflight(r);
    } finally { setChecking(false); }
  }, [client, project.id, targetType, targetShare]);

  useEffect(() => { runPreflight(); }, [runPreflight]);

  async function executeMove() {
    if (!client || !preflight?.ok) return;
    setMoving(true);
    setResult(null);
    try {
      const r = await client.projectMove(project.id, {
        storageType: targetType,
        shareId: targetType === 'shared' ? targetShare : undefined,
      }, { keepSource });
      if (r.ok) {
        setResult({ ok: true, message: `✓ Move erfolgreich (${Math.round((r.durationMs ?? 0) / 1000)}s)\nVon: ${r.sourceCwd}\nZu: ${r.targetCwd}` });
        setTimeout(() => onMoved(), 1500);
      } else {
        setResult({ ok: false, message: `✗ Move fehlgeschlagen: ${r.error}` });
      }
    } finally { setMoving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-4 max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-100">📤 Projekt verschieben — {project.name}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-red-400">✕</button>
        </div>

        <div className="space-y-3 text-xs">
          <div className="bg-[#0d0d0d] border border-[#222] rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Aktuell</div>
            <div className="font-mono text-gray-300">
              {project.storageType === 'shared' ? `shared@${project.shareId}` : `local@${project.nodeId ?? 'single'}`}
              {' · '}
              <span className="text-gray-500">{project.cwd}</span>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Ziel-Storage</label>
            <div className="flex gap-2">
              <button
                onClick={() => setTargetType('local')}
                className={`flex-1 py-2 rounded border ${targetType === 'local' ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300' : 'border-[#2a2a2a] text-gray-400'}`}
              >🖥 local (Diese Node)</button>
              <button
                onClick={() => setTargetType('shared')}
                className={`flex-1 py-2 rounded border ${targetType === 'shared' ? 'border-blue-500/60 bg-blue-500/10 text-blue-300' : 'border-[#2a2a2a] text-gray-400'}`}
              >🗄 shared (Cluster-Share)</button>
            </div>
          </div>

          {targetType === 'shared' && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Share auswählen</label>
              {loadingShares ? <div className="text-gray-500 italic">Lade Shares…</div>
                : shares.length === 0 ? <div className="text-red-400">Keine Shares konfiguriert. Erst in <code>infra.shares</code> definieren.</div>
                : (
                  <div className="space-y-1">
                    {shares.map(s => (
                      <button
                        key={s.id}
                        onClick={() => setTargetShare(s.id)}
                        disabled={!s.available || (!s.writable && !s.readOnly)}
                        className={`w-full text-left p-2 rounded border ${targetShare === s.id ? 'border-blue-500/60 bg-blue-500/10' : 'border-[#2a2a2a]'} ${(!s.available || (!s.writable && !s.readOnly)) ? 'opacity-40 cursor-not-allowed' : 'hover:border-blue-500/40'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-blue-300">{s.id}</span>
                          <span className="text-gray-500">·</span>
                          <span className="text-gray-300">{s.type}</span>
                          {s.readOnly && <span className="text-[10px] text-amber-400">read-only</span>}
                          {!s.available && <span className="text-[10px] text-red-400">offline</span>}
                          {s.available && !s.writable && !s.readOnly && <span className="text-[10px] text-red-400">not writable</span>}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5 font-mono">{s.mountPath}</div>
                        {s.reason && <div className="text-[10px] text-amber-400 mt-0.5">{s.reason}</div>}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

          <label className="flex items-center gap-1.5 text-gray-300">
            <input type="checkbox" checked={keepSource} onChange={(e) => setKeepSource(e.target.checked)} />
            Source-Verzeichnis behalten (nicht löschen nach Move)
          </label>

          <div className="bg-[#0d0d0d] border border-[#222] rounded p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Pre-Flight</span>
              <button onClick={runPreflight} disabled={checking} className="text-[10px] text-gray-500 hover:text-blue-400">↻</button>
            </div>
            {checking && <div className="text-gray-500 italic">prüfe…</div>}
            {preflight && (
              <>
                <div className="space-y-0.5 mb-2">
                  {preflight.checks.map(c => (
                    <div key={c.name} className="flex gap-2">
                      <span className={c.passed ? 'text-emerald-400 w-4' : 'text-red-400 w-4'}>{statusIcon(c)}</span>
                      <span className={`flex-1 ${c.passed ? 'text-gray-300' : 'text-red-300'}`}>
                        <code className="text-[10px] text-gray-500 mr-1">{c.name}</code>
                        {c.detail}
                      </span>
                    </div>
                  ))}
                </div>
                {preflight.sourceCwd && preflight.targetCwd && (
                  <div className="text-[10px] text-gray-500 pt-1 border-t border-[#222]">
                    <div>Source: <code className="text-gray-400">{preflight.sourceCwd}</code></div>
                    <div>Target: <code className="text-blue-400">{preflight.targetCwd}</code></div>
                  </div>
                )}
              </>
            )}
          </div>

          {result && (
            <div className={`p-2 rounded border whitespace-pre-wrap ${result.ok ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200' : 'bg-red-500/10 border-red-500/40 text-red-200'}`}>
              {result.message}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#222]">
            <button onClick={onClose} className="px-3 py-1.5 text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Abbrechen</button>
            <button
              onClick={executeMove}
              disabled={!preflight?.ok || moving}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded font-semibold"
            >{moving ? '⏳ Moving…' : '📤 Move starten'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
