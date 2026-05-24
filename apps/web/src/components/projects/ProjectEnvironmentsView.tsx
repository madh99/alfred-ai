'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  projectName: string;
}

interface StageInfo { stage: string; keyCount: number; updatedAt: string }
interface ScanKey { key: string; sources: string[] }

const KNOWN_STAGES = ['sandbox', 'dev', 'prod', 'staging'];

/**
 * v732 — Project Environments View
 * Manage encrypted ENV-Vars per Stage (prod/dev/sandbox/custom) + Scan-Repo + Copy-Stage.
 */
export function ProjectEnvironmentsView({ projectId, projectName }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [activeStage, setActiveStage] = useState<string>('sandbox');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanKey[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newStageInput, setNewStageInput] = useState('');
  const [copyFrom, setCopyFrom] = useState<string>('');

  const loadStages = useCallback(async () => {
    if (!client) return;
    try { setStages(await client.fetchEnvironmentStages(projectId)); }
    catch { /* */ }
  }, [client, projectId]);

  const loadVars = useCallback(async (stage: string, withReveal: boolean) => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const v = await client.fetchEnvironmentVars(projectId, stage, withReveal);
      setVars(v);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => {
    if (!expanded) return;
    loadStages();
  }, [expanded, loadStages]);

  useEffect(() => {
    if (!expanded || !activeStage) return;
    loadVars(activeStage, reveal);
  }, [expanded, activeStage, reveal, loadVars]);

  async function handleAddOrUpdate() {
    if (!client) return;
    const key = newKey.trim();
    if (!key) return;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) { setError(`Ungültiger Key "${key}" (A-Z, 0-9, _; muss mit Buchstabe beginnen)`); return; }
    const r = await client.setEnvironmentVars(projectId, activeStage, { [key]: newValue }, false);
    if (!r.ok) { setError(`Save fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    setNewKey(''); setNewValue('');
    await loadVars(activeStage, reveal);
    await loadStages();
  }

  async function handleDeleteKey(key: string) {
    if (!client) return;
    if (!confirm(`Key "${key}" aus Stage "${activeStage}" löschen?`)) return;
    // Bulk-Replace mit aktuellem set minus den deleted key
    const next = { ...vars };
    delete next[key];
    const r = await client.setEnvironmentVars(projectId, activeStage, next, true);
    if (!r.ok) { setError(`Delete fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    await loadVars(activeStage, reveal);
    await loadStages();
  }

  async function handleAddStage() {
    const stage = newStageInput.trim().toLowerCase();
    if (!stage || !/^[a-z][a-z0-9_-]{0,30}$/.test(stage)) { setError('Stage-Name: lowercase, max 31 chars, [a-z0-9_-], muss mit Buchstabe starten'); return; }
    setActiveStage(stage);
    setNewStageInput('');
  }

  async function handleDeleteStage(stage: string) {
    if (!client) return;
    if (!confirm(`Stage "${stage}" komplett löschen? Alle Keys werden entfernt.`)) return;
    await client.deleteEnvironmentStage(projectId, stage);
    await loadStages();
    if (activeStage === stage) setActiveStage('sandbox');
  }

  async function handleScanRepo() {
    if (!client) return;
    setScanning(true); setError(null);
    try {
      const r = await client.scanEnvironmentRepo(projectId);
      if (r.ok && r.keys) setScanResult(r.keys);
      else setError(`Scan fehlgeschlagen: ${r.reason ?? 'unknown'}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setScanning(false); }
  }

  async function handleCopyFromStage() {
    if (!client || !copyFrom || copyFrom === activeStage) return;
    if (!confirm(`Alle Keys aus "${copyFrom}" nach "${activeStage}" kopieren? (existierende Keys werden NICHT überschrieben)`)) return;
    try {
      const srcVars = await client.fetchEnvironmentVars(projectId, copyFrom, true);
      const merged = { ...srcVars, ...vars }; // current wins
      const added = Object.keys(srcVars).filter(k => !vars[k]);
      if (added.length === 0) { setError('Keine neuen Keys zu kopieren'); return; }
      const r = await client.setEnvironmentVars(projectId, activeStage, merged, true);
      if (!r.ok) { setError(`Copy fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
      await loadVars(activeStage, reveal);
      await loadStages();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const allStageNames = Array.from(new Set([...KNOWN_STAGES, ...stages.map(s => s.stage), activeStage])).filter(Boolean);
  const stagesAvailableToCopy = stages.filter(s => s.stage !== activeStage);

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>🔐 Environments ({stages.reduce((s, x) => s + Math.max(0, x.keyCount), 0)} Keys über {stages.length} Stages)</span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-3 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}

          {/* Stage-Tabs */}
          <div className="flex gap-1 flex-wrap">
            {allStageNames.map(s => {
              const info = stages.find(x => x.stage === s);
              const count = info?.keyCount ?? 0;
              const isActive = s === activeStage;
              return (
                <button
                  key={s}
                  onClick={() => setActiveStage(s)}
                  className={`px-2 py-1 rounded border ${isActive ? 'bg-purple-500/20 border-purple-500/60 text-purple-300' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}
                >
                  {s} {count > 0 && <span className="text-gray-500">({count})</span>}
                </button>
              );
            })}
            <div className="flex items-center gap-1 ml-2">
              <input
                type="text" value={newStageInput} onChange={(e) => setNewStageInput(e.target.value)}
                placeholder="neue Stage" className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-xs text-gray-200 w-32"
              />
              <button onClick={handleAddStage} className="px-2 py-1 border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded">+</button>
            </div>
          </div>

          {/* Tools-Row */}
          <div className="flex gap-2 flex-wrap items-center">
            <button onClick={() => setReveal(r => !r)} className="px-2 py-1 border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded text-[11px]">
              {reveal ? '🔒 Maskieren' : '👁 Klartext'}
            </button>
            <button onClick={handleScanRepo} disabled={scanning} className="px-2 py-1 border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 rounded text-[11px] disabled:opacity-50">
              {scanning ? '⏳ Scannt…' : '🔍 Repo scannen'}
            </button>
            {stagesAvailableToCopy.length > 0 && (
              <>
                <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200">
                  <option value="">aus Stage kopieren…</option>
                  {stagesAvailableToCopy.map(s => <option key={s.stage} value={s.stage}>{s.stage} ({s.keyCount})</option>)}
                </select>
                <button onClick={handleCopyFromStage} disabled={!copyFrom} className="px-2 py-1 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15 rounded text-[11px] disabled:opacity-50">Kopieren</button>
              </>
            )}
            {stages.find(s => s.stage === activeStage) && (
              <button onClick={() => handleDeleteStage(activeStage)} className="px-2 py-1 border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded text-[11px] ml-auto">🗑️ Stage löschen</button>
            )}
          </div>

          {/* Scan-Result */}
          {scanResult && (
            <div className="bg-blue-500/5 border border-blue-500/30 rounded p-2 space-y-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-blue-300 font-semibold">🔍 {scanResult.length} Keys im Repo gefunden</span>
                <button onClick={() => setScanResult(null)} className="text-gray-500 hover:text-gray-300">✕</button>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {scanResult.map(k => {
                  const hasIt = vars[k.key] !== undefined;
                  return (
                    <div key={k.key} className="flex items-center gap-2 text-[11px]">
                      <code className={`font-mono min-w-[200px] ${hasIt ? 'text-emerald-400' : 'text-amber-300'}`}>{hasIt ? '✓' : '·'} {k.key}</code>
                      <span className="text-gray-500 truncate" title={k.sources.join(', ')}>{k.sources.slice(0, 2).join(', ')}{k.sources.length > 2 ? ' …' : ''}</span>
                      {!hasIt && (
                        <button onClick={() => { setNewKey(k.key); setNewValue(''); }} className="ml-auto px-1.5 py-0.5 border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 rounded text-[10px]">+ Hinzufügen</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Keys-Liste */}
          <div className="space-y-1">
            {loading && <div className="text-gray-500 italic">Lädt…</div>}
            {!loading && Object.keys(vars).length === 0 && (
              <div className="text-gray-500 italic">Keine ENVs in Stage <code>{activeStage}</code> gesetzt.</div>
            )}
            {!loading && Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-[11px] bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1">
                <code className="text-amber-300 font-mono min-w-[200px]">{k}</code>
                <code className="flex-1 text-gray-300 truncate font-mono">{v}</code>
                <button onClick={() => { setNewKey(k); setNewValue(reveal ? v : ''); }} title="Editieren" className="text-blue-400 hover:text-blue-300">✎</button>
                <button onClick={() => handleDeleteKey(k)} title="Löschen" className="text-red-400 hover:text-red-300">✕</button>
              </div>
            ))}
          </div>

          {/* Add/Update-Form */}
          <div className="border-t border-[#1a1a1a] pt-3">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Key in Stage <code>{activeStage}</code> hinzufügen / überschreiben</div>
            <div className="flex gap-2">
              <input
                type="text" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} placeholder="KEY (A-Z, _)"
                className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200 font-mono"
              />
              <input
                type="text" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Wert"
                className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200 font-mono"
              />
              <button onClick={handleAddOrUpdate} disabled={!newKey.trim()} className="px-3 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-[11px]">💾 Speichern</button>
            </div>
            <div className="text-[10px] text-gray-500 mt-1">Hinweis: ENVs werden AES-GCM verschlüsselt persistiert. Sandbox-Stage wird beim Container-Start als <code>.env.local</code> in den Worktree gemerged. Project: <span className="text-gray-400">{projectName}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
