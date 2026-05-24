'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  projectName: string;
  envStages?: string[];
  dbSeeds?: Array<{ id: string; name: string }>;
}

interface TemplateItem {
  id: string;
  projectId?: string | null;
  name: string;
  description?: string;
  mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  envStage?: string;
  dbSeedId?: string;
  initialGoal?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * v751 — Sandbox-Templates pro Project. Wiederverwendbare Konfigurationen
 * für Quick-Create und Project-Detail. Global-Templates (projectId=null)
 * werden ebenfalls in der Liste mitgeführt.
 */
export function ProjectTemplatesView({ projectId, projectName, envStages = [], dbSeeds = [] }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // create-form state
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'sandbox' | 'sandbox-preview' | 'interactive-chat'>('interactive-chat');
  const [envStage, setEnvStage] = useState<string>('');
  const [dbSeedId, setDbSeedId] = useState<string>('');
  const [initialGoal, setInitialGoal] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try { setTemplates(await client.fetchSandboxTemplates(projectId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);

  async function handleCreate() {
    if (!client) return;
    const trimmed = name.trim();
    if (!trimmed) { setError('Name erforderlich'); return; }
    setSaving(true); setError(null);
    try {
      const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean);
      const r = await client.createSandboxTemplate({
        projectId: scope === 'project' ? projectId : null,
        name: trimmed,
        mode,
        envStage: envStage || undefined,
        dbSeedId: dbSeedId || undefined,
        initialGoal: initialGoal.trim() || undefined,
        tags,
      });
      if (!r.ok) { setError(`Create fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
      setName(''); setInitialGoal(''); setTagInput(''); setEnvStage(''); setDbSeedId('');
      await load();
    } finally { setSaving(false); }
  }

  async function handleDelete(t: TemplateItem) {
    if (!client) return;
    if (!confirm(`Template "${t.name}" löschen?`)) return;
    const r = await client.deleteSandboxTemplate(t.id);
    if (!r.ok) { setError(`Delete fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    await load();
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>📦 Sandbox-Templates ({templates.length})</span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-3 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}
          <div className="text-[10px] text-gray-500">
            Wiederverwendbare Sandbox-Konfigurationen für <span className="text-gray-400">{projectName}</span>. Global-Templates sind allen Projects verfügbar.
          </div>

          <div className="space-y-1">
            {loading && <div className="text-gray-500 italic">Lädt…</div>}
            {!loading && templates.length === 0 && (
              <div className="text-gray-500 italic">Noch keine Templates. Lege unten eines an.</div>
            )}
            {!loading && templates.map(t => {
              const isGlobal = !t.projectId;
              return (
                <div key={t.id} className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1">
                  <span title={isGlobal ? 'Global (alle Projects)' : 'Nur dieses Project'}>{isGlobal ? '🌐' : '📌'}</span>
                  <span className="text-gray-300 flex-1 truncate" title={t.description}>{t.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">{t.mode}</span>
                  {t.envStage && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">{t.envStage}</span>}
                  {t.dbSeedId && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30" title={`Seed: ${t.dbSeedId}`}>💾</span>}
                  {t.tags.length > 0 && (
                    <span className="text-[10px] text-gray-500" title={t.tags.join(', ')}>#{t.tags.length}</span>
                  )}
                  <button onClick={() => handleDelete(t)} title="Löschen" className="text-red-400 hover:text-red-300">✕</button>
                </div>
              );
            })}
          </div>

          {/* Create-Form */}
          <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Neues Template</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Name (z.B. nightly-debug)"
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              />
              <select
                value={mode} onChange={e => setMode(e.target.value as 'sandbox' | 'sandbox-preview' | 'interactive-chat')}
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              >
                <option value="interactive-chat">interactive-chat</option>
                <option value="sandbox-preview">sandbox-preview</option>
                <option value="sandbox">sandbox</option>
              </select>
              <select
                value={envStage} onChange={e => setEnvStage(e.target.value)}
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              >
                <option value="">— ENV-Stage —</option>
                {envStages.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={dbSeedId} onChange={e => setDbSeedId(e.target.value)}
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              >
                <option value="">— DB-Seed —</option>
                {dbSeeds.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <textarea
              value={initialGoal} onChange={e => setInitialGoal(e.target.value)}
              placeholder="Initial-Goal (für interactive-chat) — z.B. 'Bug XY reproduzieren'"
              rows={2}
              className="w-full bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
            />
            <div className="flex gap-2">
              <input
                type="text" value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="Tags, kommagetrennt"
                className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              />
              <select
                value={scope} onChange={e => setScope(e.target.value as 'project' | 'global')}
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
                title="Scope: nur dieses Project oder global für alle"
              >
                <option value="project">📌 dieses Project</option>
                <option value="global">🌐 global</option>
              </select>
              <button
                onClick={handleCreate} disabled={saving || !name.trim()}
                className="px-3 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-[11px]"
              >
                {saving ? '⏳…' : '+ Anlegen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
