'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

const KNOWN_STAGES = ['sandbox', 'dev', 'prod', 'staging'];

/**
 * v735 — Quick-Create-Modal für Sandboxes direkt aus Project-Detail.
 * Lädt envStages + dbSeeds beim Öffnen, lässt User Mode/Stage/Seed wählen,
 * createSandbox + bei interactive-chat sofort redirect zur Interactive-Page.
 */
export function SandboxQuickCreateModal({ projectId, projectName, onClose }: Props) {
  const { client } = useConfig();
  const [mode, setMode] = useState<'sandbox' | 'sandbox-preview' | 'interactive-chat'>('interactive-chat');
  const [envStage, setEnvStage] = useState<string>('sandbox');
  const [seedId, setSeedId] = useState<string>(''); // '' = project-default, 'none' = empty
  const [stages, setStages] = useState<Array<{ stage: string; keyCount: number }>>([]);
  const [seeds, setSeeds] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const [st, sd] = await Promise.all([
          client.fetchEnvironmentStages(projectId).catch(() => []),
          client.fetchDbSeeds(projectId).catch(() => []),
        ]);
        if (cancelled) return;
        setStages(st);
        setSeeds(sd);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [client, projectId]);

  async function handleCreate() {
    if (!client) return;
    setBusy(true); setError(null);
    try {
      const dbSeedId = seedId === '' ? undefined : (seedId === 'none' ? null : seedId);
      const sb = await client.createSandbox({
        projectId,
        sessionId: null,
        mode,
        envStage,
        dbSeedId,
      });
      onClose();
      // Bei Interactive: direkt zur Interactive-Page navigieren
      if (mode === 'interactive-chat') {
        window.location.href = `/alfred/interactive?sandboxId=${sb.id}`;
      } else {
        // Sonst: Sandboxes-Übersicht öffnen
        window.location.href = `/alfred/sandboxes`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const allStages = Array.from(new Set([...KNOWN_STAGES, ...stages.map(s => s.stage)]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-blue-500/40 bg-[#0f0f0f] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-blue-300">🧪 Sandbox erstellen — {projectName}</h2>
          <button onClick={onClose} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded mb-2 text-xs">{error}</div>}

        <div className="space-y-3 text-xs">
          {/* Mode */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              <option value="sandbox">Sandbox (Worktree-Isolation, kein Preview)</option>
              <option value="sandbox-preview">Sandbox + Preview (Dev-Server + iframe)</option>
              <option value="interactive-chat">Interactive Chat (dialogisch + Preview) — empfohlen</option>
            </select>
          </div>

          {/* ENV-Stage */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">🔐 ENV-Stage</label>
            <select value={envStage} onChange={(e) => setEnvStage(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              {allStages.map(s => {
                const info = stages.find(x => x.stage === s);
                return <option key={s} value={s}>{s}{info ? ` (${info.keyCount} Keys)` : ' (leer)'}</option>;
              })}
            </select>
            <div className="text-[10px] text-gray-500 mt-0.5">Wird als <code>.env.local</code> in den Container-Worktree gemerged.</div>
          </div>

          {/* DB-Seed */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">💾 DB-Seed</label>
            <select value={seedId} onChange={(e) => setSeedId(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              <option value="">Project-Default verwenden</option>
              <option value="none">Leer (kein Seed)</option>
              {seeds.map(s => <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>)}
            </select>
            <div className="text-[10px] text-gray-500 mt-0.5">Seed wird beim Start nach <code>.alfred-data/</code> kopiert.</div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2 border-t border-[#1a1a1a]">
            <button onClick={onClose} disabled={busy} className="px-3 py-1.5 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px] disabled:opacity-50">Abbrechen</button>
            <button onClick={handleCreate} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-[11px]">
              {busy ? '⏳ Erstelle…' : '🧪 Sandbox starten'}
            </button>
          </div>
          <div className="text-[10px] text-gray-600">Erstellung dauert beim ersten Mal 1-3 min (Image-Build), danach &lt;30s. Bei Interactive-Mode wird automatisch die Chat-Page geöffnet.</div>
        </div>
      </div>
    </div>
  );
}
