'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  projectName: string;
}

interface StageInfo { stage: string; keyCount: number; updatedAt: string }
interface ScanKey { key: string; sources: string[] }
interface ImportRow { key: string; value: string; conflict: boolean; include: boolean }
interface DiffRow { key: string; valA?: string; valB?: string; kind: 'only_a' | 'only_b' | 'different' | 'same' }

const KNOWN_STAGES = ['sandbox', 'dev', 'prod', 'staging'];

/** v734 — Parser für .env-Files: KEY=VALUE, Quotes raus, Kommentare/Empty skip. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Quotes entfernen wenn umschlossen
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Escape-Sequences in double-quotes
    if (line.slice(eq + 1).trim().startsWith('"')) {
      value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[key] = value;
  }
  return out;
}

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
  // v734 — Import + Diff
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importReplace, setImportReplace] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffStageA, setDiffStageA] = useState<string>('sandbox');
  const [diffStageB, setDiffStageB] = useState<string>('prod');
  const [diffRows, setDiffRows] = useState<DiffRow[]>([]);
  const [diffReveal, setDiffReveal] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);

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

  // v734 — File-Import: Datei einlesen, parsen, Konflikte gegen aktuelle vars prüfen, Preview-Modal öffnen
  async function handleImportFile(file: File) {
    if (file.size > 1024 * 1024) { setError('.env-File zu groß (max 1 MB)'); return; }
    try {
      const text = await file.text();
      const parsed = parseEnvFile(text);
      const rows: ImportRow[] = Object.entries(parsed).map(([k, v]) => ({
        key: k, value: v, conflict: vars[k] !== undefined, include: true,
      })).sort((a, b) => a.key.localeCompare(b.key));
      if (rows.length === 0) { setError(`Keine gültigen KEY=VALUE-Zeilen in ${file.name} gefunden`); return; }
      setImportRows(rows);
      setImportReplace(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function executeImport() {
    if (!client || !importRows) return;
    const toSet: Record<string, string> = {};
    for (const r of importRows) if (r.include) toSet[r.key] = r.value;
    if (Object.keys(toSet).length === 0) { setImportRows(null); return; }
    const merged = importReplace ? toSet : { ...vars, ...toSet };
    const r = await client.setEnvironmentVars(projectId, activeStage, merged, true);
    if (!r.ok) { setError(`Import fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    setImportRows(null);
    await loadVars(activeStage, reveal);
    await loadStages();
  }

  // v734 — Diff zwischen zwei Stages berechnen
  async function loadDiff() {
    if (!client || !diffStageA || !diffStageB || diffStageA === diffStageB) { setDiffRows([]); return; }
    setDiffLoading(true);
    try {
      const [a, b]: [Record<string, string>, Record<string, string>] = await Promise.all([
        client.fetchEnvironmentVars(projectId, diffStageA, true).catch(() => ({} as Record<string, string>)),
        client.fetchEnvironmentVars(projectId, diffStageB, true).catch(() => ({} as Record<string, string>)),
      ]);
      const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
      const rows: DiffRow[] = [];
      for (const k of Array.from(allKeys).sort()) {
        const valA = a[k];
        const valB = b[k];
        if (valA === undefined) rows.push({ key: k, valB, kind: 'only_b' });
        else if (valB === undefined) rows.push({ key: k, valA, kind: 'only_a' });
        else if (valA !== valB) rows.push({ key: k, valA, valB, kind: 'different' });
        else rows.push({ key: k, valA, valB, kind: 'same' });
      }
      setDiffRows(rows);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDiffLoading(false); }
  }

  useEffect(() => { if (diffOpen) loadDiff(); /* eslint-disable-next-line */ }, [diffOpen, diffStageA, diffStageB]);

  async function syncDiffRowsAtoB(rowKeys: string[]) {
    if (!client || rowKeys.length === 0) return;
    const toSync: Record<string, string> = {};
    for (const row of diffRows) {
      if (rowKeys.includes(row.key) && row.valA !== undefined) toSync[row.key] = row.valA;
    }
    if (Object.keys(toSync).length === 0) return;
    const current = await client.fetchEnvironmentVars(projectId, diffStageB, true).catch(() => ({}));
    const merged = { ...current, ...toSync };
    const r = await client.setEnvironmentVars(projectId, diffStageB, merged, true);
    if (!r.ok) { setError(`Sync fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    await loadDiff();
    if (activeStage === diffStageB) await loadVars(activeStage, reveal);
    await loadStages();
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
            <button onClick={() => fileInputRef.current?.click()} className="px-2 py-1 border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 rounded text-[11px]">📤 .env importieren</button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".env,.env.example,.env.local,.env.prod,.env.sample,.env.template,text/plain"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }}
            />
            <button onClick={() => setDiffOpen(true)} className="px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded text-[11px]">⚖️ Diff</button>
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

      {/* v734 — Import-Preview-Modal */}
      {importRows && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setImportRows(null)}>
          <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-amber-500/40 bg-[#0f0f0f] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-amber-300">📤 .env Import-Vorschau ({importRows.length} Keys → Stage <code>{activeStage}</code>)</h2>
              <button onClick={() => setImportRows(null)} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
            </div>
            <div className="flex items-center gap-3 mb-2 text-[11px]">
              <label className="flex items-center gap-1 text-gray-400">
                <input type="checkbox" checked={importReplace} onChange={(e) => setImportReplace(e.target.checked)} />
                Stage komplett <strong>ersetzen</strong> statt mergen
              </label>
              <button onClick={() => setImportRows(importRows.map(r => ({ ...r, include: true })))} className="text-blue-400 hover:text-blue-300">alle wählen</button>
              <span className="text-gray-600">·</span>
              <button onClick={() => setImportRows(importRows.map(r => ({ ...r, include: !r.conflict })))} className="text-blue-400 hover:text-blue-300">nur neue</button>
              <span className="text-gray-600">·</span>
              <button onClick={() => setImportRows(importRows.map(r => ({ ...r, include: false })))} className="text-blue-400 hover:text-blue-300">keine</button>
            </div>
            <div className="flex-1 overflow-auto space-y-1">
              {importRows.map((r, i) => (
                <div key={r.key} className="flex items-center gap-2 text-[11px] bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1">
                  <input
                    type="checkbox" checked={r.include}
                    onChange={(e) => setImportRows(importRows.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))}
                  />
                  <code className={`font-mono min-w-[180px] ${r.conflict ? 'text-orange-300' : 'text-emerald-400'}`}>{r.key}</code>
                  <code className="flex-1 text-gray-300 truncate font-mono" title={r.value}>{r.value.length > 4 ? r.value.slice(0, 2) + '****' + r.value.slice(-2) : '****'}</code>
                  {r.conflict && <span className="text-[10px] text-orange-300">⚠ existiert</span>}
                </div>
              ))}
            </div>
            <div className="border-t border-[#1a1a1a] pt-3 mt-3 flex justify-end gap-2">
              <button onClick={() => setImportRows(null)} className="px-3 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">Abbrechen</button>
              <button onClick={executeImport} className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[11px]">
                {importReplace ? 'Stage ERSETZEN' : 'Merge importieren'} ({importRows.filter(r => r.include).length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* v734 — Diff-Modal */}
      {diffOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setDiffOpen(false)}>
          <div className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-lg border border-cyan-500/40 bg-[#0f0f0f] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-cyan-300">⚖️ ENV-Diff zwischen Stages</h2>
              <button onClick={() => setDiffOpen(false)} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
            </div>
            <div className="flex items-center gap-2 mb-3 text-[11px]">
              <select value={diffStageA} onChange={(e) => setDiffStageA(e.target.value)} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-gray-200">
                {Array.from(new Set(['sandbox', 'dev', 'prod', 'staging', ...stages.map(s => s.stage)])).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-gray-500">↔</span>
              <select value={diffStageB} onChange={(e) => setDiffStageB(e.target.value)} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-gray-200">
                {Array.from(new Set(['sandbox', 'dev', 'prod', 'staging', ...stages.map(s => s.stage)])).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={() => setDiffReveal(!diffReveal)} className="ml-auto px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded">
                {diffReveal ? '🔒 Maskieren' : '👁 Klartext'}
              </button>
            </div>
            <div className="flex-1 overflow-auto space-y-0.5 text-[11px]">
              {diffLoading && <div className="text-gray-500 italic">Lädt…</div>}
              {!diffLoading && diffStageA === diffStageB && <div className="text-gray-500 italic">Wähle zwei verschiedene Stages</div>}
              {!diffLoading && diffStageA !== diffStageB && diffRows.filter(r => r.kind !== 'same').length === 0 && (
                <div className="text-emerald-400">✓ Stages sind identisch</div>
              )}
              {!diffLoading && diffStageA !== diffStageB && diffRows.filter(r => r.kind !== 'same').map(r => {
                const mask = (v?: string) => v === undefined ? '—' : (diffReveal ? v : (v.length > 4 ? v.slice(0, 2) + '****' + v.slice(-2) : '****'));
                const color = r.kind === 'only_a' ? 'border-l-4 border-l-emerald-500' : r.kind === 'only_b' ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-orange-500';
                const icon = r.kind === 'only_a' ? '◀' : r.kind === 'only_b' ? '▶' : '≠';
                return (
                  <div key={r.key} className={`flex items-center gap-2 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 ${color}`}>
                    <span className="text-gray-500 font-mono w-4">{icon}</span>
                    <code className="text-amber-300 font-mono min-w-[180px]">{r.key}</code>
                    <code className={`flex-1 truncate font-mono ${r.kind === 'only_b' ? 'text-gray-600' : 'text-gray-300'}`}>{mask(r.valA)}</code>
                    <span className="text-gray-600">↔</span>
                    <code className={`flex-1 truncate font-mono ${r.kind === 'only_a' ? 'text-gray-600' : 'text-gray-300'}`}>{mask(r.valB)}</code>
                    {(r.kind === 'only_a' || r.kind === 'different') && (
                      <button onClick={() => syncDiffRowsAtoB([r.key])} title={`${diffStageA} → ${diffStageB}`} className="text-[10px] px-1.5 py-0.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded">→</button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-[#1a1a1a] pt-3 mt-3 flex justify-between items-center text-[11px]">
              <div className="text-gray-500">
                {diffRows.length > 0 && (
                  <>
                    <span className="text-emerald-400">◀ {diffRows.filter(r => r.kind === 'only_a').length}</span>
                    {' · '}
                    <span className="text-orange-400">≠ {diffRows.filter(r => r.kind === 'different').length}</span>
                    {' · '}
                    <span className="text-blue-400">▶ {diffRows.filter(r => r.kind === 'only_b').length}</span>
                    {' · '}
                    <span className="text-gray-600">= {diffRows.filter(r => r.kind === 'same').length}</span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => syncDiffRowsAtoB(diffRows.filter(r => r.kind === 'only_a' || r.kind === 'different').map(r => r.key))}
                  disabled={diffRows.filter(r => r.kind === 'only_a' || r.kind === 'different').length === 0}
                  className="px-3 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 rounded disabled:opacity-40"
                  title={`Alle nicht-gleichen Keys von ${diffStageA} nach ${diffStageB} kopieren`}
                >
                  Alle {diffStageA} → {diffStageB}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
