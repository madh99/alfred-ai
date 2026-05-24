'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  projectName: string;
  defaultSeedId?: string | null;
}

interface SeedItem {
  id: string;
  name: string;
  kind: string;
  storageRef: string;
  sizeBytes: number;
  createdAt: string;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * v732 — Project DB-Seeds View
 * Verwaltet pro Project DB-Seed-Files: Upload, Repo-Path-Registration, Default-Auswahl.
 * Seeds werden beim Sandbox-Start (sb-manager.prepareSandboxDataDir) optional in
 * .alfred-data/ kopiert damit die App eine deterministische Start-DB hat.
 */
export function ProjectDbSeedsView({ projectId, projectName, defaultSeedId }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [seeds, setSeeds] = useState<SeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultSelected, setDefaultSelected] = useState<string | null>(defaultSeedId ?? null);
  const [uploadingName, setUploadingName] = useState<string>('');
  const [repoPathName, setRepoPathName] = useState<string>('');
  const [repoPath, setRepoPath] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try { setSeeds(await client.fetchDbSeeds(projectId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);

  async function handleFileUpload(file: File) {
    if (!client) return;
    if (file.size > 100 * 1024 * 1024) { setError('File > 100 MB, zu groß'); return; }
    setUploadingName(file.name);
    setError(null);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await client.uploadDbSeed(projectId, file.name, dataUrl);
      if (!r.ok) { setError(`Upload fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setUploadingName(''); }
  }

  async function handleRegisterRepoPath() {
    if (!client) return;
    const n = repoPathName.trim();
    const p = repoPath.trim();
    if (!n || !p) { setError('Name + Pfad erforderlich'); return; }
    setError(null);
    const r = await client.registerDbSeedRepoPath(projectId, n, p);
    if (!r.ok) { setError(`Registrierung fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    setRepoPathName(''); setRepoPath('');
    await load();
  }

  async function handleDelete(seed: SeedItem) {
    if (!client) return;
    if (!confirm(`Seed "${seed.name}" löschen?${seed.kind === 'upload' ? ' (Datei wird vom Storage entfernt)' : ''}`)) return;
    const r = await client.deleteDbSeed(projectId, seed.id);
    if (!r.ok) { setError(`Delete fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    if (defaultSelected === seed.id) setDefaultSelected(null);
    await load();
  }

  async function handleSetDefault(seedId: string | null) {
    if (!client) return;
    const r = await client.setDefaultDbSeed(projectId, seedId);
    if (!r.ok) { setError(`Default setzen fehlgeschlagen: ${r.reason ?? 'unknown'}`); return; }
    setDefaultSelected(seedId);
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>💾 DB-Seeds ({seeds.length})</span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-3 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}

          <div className="text-[10px] text-gray-500">
            Seeds werden beim Sandbox-Erstellen optional in <code>.alfred-data/</code> kopiert damit die App mit deterministischen Test-Daten startet.
            Project: <span className="text-gray-400">{projectName}</span>
          </div>

          {/* Seeds-Liste */}
          <div className="space-y-1">
            {loading && <div className="text-gray-500 italic">Lädt…</div>}
            {!loading && seeds.length === 0 && (
              <div className="text-gray-500 italic">Noch keine Seeds. Upload eine Datei oder registriere einen Repo-Pfad.</div>
            )}
            {!loading && seeds.map(s => {
              const isDefault = s.id === defaultSelected;
              return (
                <div key={s.id} className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1">
                  <span>{s.kind === 'upload' ? '📤' : '📂'}</span>
                  <span className="text-gray-300 flex-1 truncate" title={s.storageRef}>{s.name}</span>
                  <span className="text-gray-500">{s.kind === 'upload' ? formatBytes(s.sizeBytes) : <code className="text-[10px]">{s.storageRef}</code>}</span>
                  <button
                    onClick={() => handleSetDefault(isDefault ? null : s.id)}
                    title={isDefault ? 'Default entfernen' : 'Als Default für neue Sandboxes setzen'}
                    className={`text-[10px] px-2 py-0.5 rounded border ${isDefault ? 'border-amber-500/60 text-amber-300 bg-amber-500/15' : 'border-gray-600 text-gray-400 hover:border-amber-500/40 hover:text-amber-400'}`}
                  >
                    {isDefault ? '★ Default' : '☆ als Default'}
                  </button>
                  <button onClick={() => handleDelete(s)} title="Löschen" className="text-red-400 hover:text-red-300">✕</button>
                </div>
              );
            })}
          </div>

          {/* Upload-Form */}
          <div className="border-t border-[#1a1a1a] pt-3 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Seed-File hochladen</div>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!uploadingName}
                  className="px-3 py-1 border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded text-[11px] disabled:opacity-50"
                >
                  {uploadingName ? `⏳ ${uploadingName}…` : '📤 Datei wählen…'}
                </button>
                <span className="text-[10px] text-gray-500">max 100 MB · z.B. seed.sqlite, dump.sql</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }}
                />
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">… oder Pfad im Repo registrieren</div>
              <div className="flex gap-2">
                <input
                  type="text" value={repoPathName} onChange={(e) => setRepoPathName(e.target.value)} placeholder="Name (z.B. dev-seed)"
                  className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200 w-40"
                />
                <input
                  type="text" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="seeds/dev.sqlite"
                  className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200 font-mono"
                />
                <button onClick={handleRegisterRepoPath} disabled={!repoPathName.trim() || !repoPath.trim()} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-[11px]">+ Registrieren</button>
              </div>
              <div className="text-[10px] text-gray-500 mt-1">Pfad relativ zu project-cwd. Datei muss existieren UND committable sein (Demo-Daten, nicht Production).</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
