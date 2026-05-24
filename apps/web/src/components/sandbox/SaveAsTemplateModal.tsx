'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  sandboxId: string;
  /** Pre-fill: aktueller Mode der Sandbox (aus Page-Kontext). */
  presetMode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  onClose: () => void;
  onSaved?: (templateId: string) => void;
}

/**
 * v752 — Save-as-Template: speichert Setup einer laufenden Sandbox als Template.
 * Mode wird aus dem Page-Kontext gesetzt, initialGoal aus der ersten User-Chat-Message.
 * ENV-Stage + DB-Seed kann der User wählen (werden nicht auf der Sandbox-Row persistiert).
 */
export function SaveAsTemplateModal({ projectId, sandboxId, presetMode, onClose, onSaved }: Props) {
  const { client } = useConfig();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState(presetMode);
  const [envStage, setEnvStage] = useState('');
  const [dbSeedId, setDbSeedId] = useState('');
  const [initialGoal, setInitialGoal] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [stages, setStages] = useState<Array<{ stage: string; keyCount: number }>>([]);
  const [seeds, setSeeds] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const [st, sd, chat] = await Promise.all([
          client.fetchEnvironmentStages(projectId).catch(() => []),
          client.fetchDbSeeds(projectId).catch(() => []),
          client.fetchSandboxChat(sandboxId).catch(() => []),
        ]);
        if (cancelled) return;
        setStages(st);
        setSeeds(sd);
        const firstUser = chat.find(m => m.role === 'user');
        if (firstUser?.text) setInitialGoal(firstUser.text.slice(0, 500));
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [client, projectId, sandboxId]);

  async function handleSave() {
    if (!client) return;
    const trimmed = name.trim();
    if (!trimmed) { setError('Name erforderlich'); return; }
    setBusy(true); setError(null);
    try {
      const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean);
      const r = await client.createSandboxTemplate({
        projectId: scope === 'project' ? projectId : null,
        name: trimmed,
        description: description.trim() || undefined,
        mode,
        envStage: envStage || undefined,
        dbSeedId: dbSeedId || undefined,
        initialGoal: initialGoal.trim() || undefined,
        tags,
      });
      if (!r.ok) { setError(`Speichern fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
      onSaved?.(r.id ?? '');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-purple-500/40 bg-[#0f0f0f] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-purple-300">📦 Als Template speichern</h2>
          <button onClick={onClose} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded mb-2 text-xs">{error}</div>}

        <div className="space-y-3 text-xs">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Name *</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)} placeholder="z.B. debug-auth-flow"
              className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" autoFocus
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Beschreibung (optional)</label>
            <input
              type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Wofür ist das Template gedacht?"
              className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Mode</label>
              <select value={mode} onChange={e => setMode(e.target.value as typeof mode)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                <option value="interactive-chat">interactive-chat</option>
                <option value="sandbox-preview">sandbox-preview</option>
                <option value="sandbox">sandbox</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Scope</label>
              <select value={scope} onChange={e => setScope(e.target.value as 'project' | 'global')} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                <option value="project">📌 dieses Project</option>
                <option value="global">🌐 global</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">ENV-Stage</label>
              <select value={envStage} onChange={e => setEnvStage(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                <option value="">— keine —</option>
                {stages.map(s => <option key={s.stage} value={s.stage}>{s.stage} ({s.keyCount})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">DB-Seed</label>
              <select value={dbSeedId} onChange={e => setDbSeedId(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                <option value="">— kein Seed —</option>
                {seeds.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Initial-Goal (pre-filled aus erster Chat-Msg)</label>
            <textarea
              value={initialGoal} onChange={e => setInitialGoal(e.target.value)} rows={2}
              className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Tags (kommagetrennt)</label>
            <input
              type="text" value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="z.B. debug, auth, regression"
              className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[#1a1a1a]">
            <button onClick={onClose} disabled={busy} className="px-3 py-1.5 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px] disabled:opacity-50">Abbrechen</button>
            <button onClick={handleSave} disabled={busy || !name.trim()} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-[11px]">
              {busy ? '⏳ Speichere…' : '📦 Template speichern'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
