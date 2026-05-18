'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type {
  Project, ProjectDetail, ProjectStatus, ProjectHealthMode, ProjectOpenItem,
  HealthProbe,
} from '@/lib/alfred-client';

const STATUS_BADGES: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  paused: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  completed: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  maintenance: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
  archived: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
};

const HEALTH_ICON: Record<string, string> = {
  ok: '✓', warning: '⚠', error: '✗', skipped: '·',
};
const HEALTH_COLOR: Record<string, string> = {
  ok: 'text-emerald-400', warning: 'text-amber-400', error: 'text-red-400', skipped: 'text-gray-500',
};

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return iso.slice(0, 10);
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'gerade';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

function priorityIcon(p: string): string {
  return p === 'high' ? '🔴' : p === 'low' ? '⚪' : '🟡';
}

export function ProjectsPage() {
  const { client } = useConfig();
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCwd, setNewCwd] = useState('');
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemPriority, setNewItemPriority] = useState<'low' | 'normal' | 'high'>('normal');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchProjects(filterStatus === 'all' ? {} : { status: filterStatus });
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client, filterStatus]);

  useEffect(() => { load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    if (!client) return;
    try {
      const d = await client.fetchProject(id);
      setDetail(d);
    } catch { setDetail(null); }
  }, [client]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  async function handleCreate() {
    if (!client || !newName.trim()) return;
    const created = await client.createProject({
      name: newName.trim(),
      description: newDesc.trim() || undefined,
      cwd: newCwd.trim() || undefined,
      repoUrl: newRepoUrl.trim() || undefined,
    });
    if (created) {
      setProjects(prev => [created, ...prev]);
      setSelectedId(created.id);
      setCreating(false);
      setNewName(''); setNewDesc(''); setNewCwd(''); setNewRepoUrl('');
    } else { alert('Anlegen fehlgeschlagen.'); }
  }

  async function setStatus(p: Project, status: ProjectStatus) {
    if (!client) return;
    const updated = await client.updateProject(p.id, { status });
    if (updated) {
      setProjects(prev => prev.map(x => x.id === updated.id ? updated : x));
      if (detail?.project.id === updated.id) setDetail({ ...detail, project: updated });
    }
  }

  async function setHealthMode(p: Project, healthMode: ProjectHealthMode) {
    if (!client) return;
    const updated = await client.updateProject(p.id, { healthMode });
    if (updated) {
      setProjects(prev => prev.map(x => x.id === updated.id ? updated : x));
      if (detail?.project.id === updated.id) setDetail({ ...detail, project: updated });
    }
  }

  async function saveName(p: Project) {
    if (!client || !nameInput.trim()) return;
    const updated = await client.updateProject(p.id, { name: nameInput.trim() });
    if (updated) {
      setProjects(prev => prev.map(x => x.id === updated.id ? updated : x));
      if (detail?.project.id === updated.id) setDetail({ ...detail, project: updated });
    }
    setEditingName(false);
  }

  async function archiveProject(p: Project) {
    if (!client) return;
    if (!confirm(`Projekt "${p.name}" archivieren?`)) return;
    const ok = await client.archiveProject(p.id);
    if (ok) {
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status: 'archived' } : x));
      if (filterStatus !== 'archived' && filterStatus !== 'all') {
        setSelectedId(null);
      } else if (detail?.project.id === p.id) {
        setDetail({ ...detail, project: { ...detail.project, status: 'archived' } });
      }
    }
  }

  async function addOpenItem() {
    if (!client || !detail || !newItemTitle.trim()) return;
    const item = await client.addProjectOpenItem(detail.project.id, {
      title: newItemTitle.trim(),
      priority: newItemPriority,
    });
    if (item) {
      setDetail({ ...detail, openItems: [...detail.openItems, item] });
      setNewItemTitle('');
    }
  }

  async function resolveOpenItem(item: ProjectOpenItem) {
    if (!client) return;
    const ok = await client.updateProjectOpenItem(item.id, 'done');
    if (ok && detail) {
      setDetail({
        ...detail,
        openItems: detail.openItems.map(it => it.id === item.id ? { ...it, status: 'done' as const } : it),
      });
    }
  }

  const visible = projects
    .filter(p => !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (p.cwd ?? '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Projekte</h1>
          <p className="text-sm text-gray-500 mt-1">
            Langlebige Container für Project-Agent / Code-Agent / Delegate-Sessions. Open-Items, Decisions und Health-Status pro Projekt.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCreating(c => !c)}
            className="px-4 py-2 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 rounded-lg text-sm border border-emerald-500/30"
          >
            + Neues Projekt
          </button>
          <button
            onClick={load}
            className="px-4 py-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg text-sm border border-blue-500/30"
          >
            Aktualisieren
          </button>
        </div>
      </div>

      {creating && (
        <div className="mb-4 p-4 bg-[#141414] border border-[#222] rounded-lg space-y-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Projektname *" className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200" />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Beschreibung (optional)" className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200" />
          <input value={newCwd} onChange={e => setNewCwd(e.target.value)} placeholder="cwd (Arbeitsverzeichnis, optional)" className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200 font-mono" />
          <input value={newRepoUrl} onChange={e => setNewRepoUrl(e.target.value)} placeholder="Repo-URL / Deploy-URL (optional)" className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200" />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/40 text-sm">Anlegen</button>
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 bg-[#1a1a1a] text-gray-400 rounded border border-[#2a2a2a] text-sm">Abbrechen</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {['all', 'active', 'paused', 'maintenance', 'completed', 'archived'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${filterStatus === s ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
          >
            {s === 'all' ? `Alle (${projects.length})` : s}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="Suchen in Name, Beschreibung, cwd..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none mb-4"
      />

      {loading && <div className="text-gray-500 text-sm">Lade...</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {!loading && visible.length === 0 && (
        <div className="text-gray-500 text-sm py-8 text-center">Keine Projekte gefunden.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* List */}
        <div className="md:col-span-1 space-y-2 max-h-[80vh] overflow-y-auto">
          {visible.map(p => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedId === p.id ? 'bg-blue-500/10 border-blue-500/40' : 'bg-[#141414] border-[#222] hover:border-[#333]'}`}
            >
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={`px-1.5 py-0.5 text-[10px] uppercase font-mono rounded border ${STATUS_BADGES[p.status] ?? STATUS_BADGES.active}`}>{p.status}</span>
                <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#222] text-gray-500 border border-[#2a2a2a]">health:{p.healthMode}</span>
                <span className="text-[10px] text-gray-600 font-mono ml-auto">{p.id.slice(0, 8)}</span>
              </div>
              <div className="text-sm text-gray-200 font-medium">{p.name}</div>
              {p.cwd && <div className="text-[11px] text-gray-500 font-mono truncate">{p.cwd}</div>}
              <div className="text-[10px] text-gray-600 mt-1">aktiv vor {relativeTime(p.lastActiveAt)}</div>
            </div>
          ))}
        </div>

        {/* Detail */}
        <div className="md:col-span-2 p-4 bg-[#141414] border border-[#222] rounded-lg min-h-[400px]">
          {!detail && (
            <div className="text-gray-500 text-sm text-center py-12">
              Wähle ein Projekt aus der Liste links.
            </div>
          )}
          {detail && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                {editingName ? (
                  <div className="flex gap-2 flex-1">
                    <input value={nameInput} onChange={e => setNameInput(e.target.value)} className="flex-1 px-3 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200" />
                    <button onClick={() => saveName(detail.project)} className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/40 text-sm">Speichern</button>
                    <button onClick={() => setEditingName(false)} className="px-3 py-1.5 bg-[#1a1a1a] text-gray-400 rounded border border-[#2a2a2a] text-sm">×</button>
                  </div>
                ) : (
                  <h2 className="text-xl font-bold text-gray-100 flex items-center gap-2">
                    {detail.project.name}
                    <button onClick={() => { setNameInput(detail.project.name); setEditingName(true); }} className="text-xs text-gray-500 hover:text-gray-300">✎</button>
                  </h2>
                )}
                <div className="flex gap-2 flex-wrap">
                  {detail.project.status !== 'archived' && (
                    <button onClick={() => archiveProject(detail.project)} className="px-3 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded border border-red-500/30">Archivieren</button>
                  )}
                </div>
              </div>

              <div className="flex gap-2 flex-wrap text-[11px] text-gray-500 font-mono">
                <span>{detail.project.id}</span>
                {detail.project.slug && <><span>·</span><span>slug: {detail.project.slug}</span></>}
                <span>·</span>
                <span>Letzte Aktivität: {relativeTime(detail.project.lastActiveAt)}</span>
              </div>

              {detail.project.description && <p className="text-sm text-gray-300">{detail.project.description}</p>}
              {detail.project.cwd && <div className="text-xs text-gray-500"><span className="text-gray-600">cwd:</span> <code className="bg-[#1a1a1a] px-1.5 py-0.5 rounded">{detail.project.cwd}</code></div>}
              {detail.project.repoUrl && <div className="text-xs text-gray-500"><span className="text-gray-600">repo:</span> <a href={detail.project.repoUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{detail.project.repoUrl}</a></div>}

              {/* Status + Health-Mode Switcher */}
              <div className="flex flex-wrap gap-3 pt-2 border-t border-[#222]">
                <div>
                  <div className="text-[10px] text-gray-500 mb-1">Status</div>
                  <div className="flex gap-1">
                    {(['active', 'paused', 'maintenance', 'completed'] as ProjectStatus[]).map(s => (
                      <button key={s} onClick={() => setStatus(detail.project, s)} className={`px-2 py-1 text-[11px] rounded border ${detail.project.status === s ? STATUS_BADGES[s] : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}>{s}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-500 mb-1">Health-Mode</div>
                  <div className="flex gap-1">
                    {(['full', 'minimal', 'off'] as ProjectHealthMode[]).map(m => (
                      <button key={m} onClick={() => setHealthMode(detail.project, m)} className={`px-2 py-1 text-[11px] rounded border ${detail.project.healthMode === m ? 'bg-purple-500/20 text-purple-400 border-purple-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}>{m}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Health-Probes */}
              <div className="pt-2 border-t border-[#222]">
                <h3 className="text-sm font-semibold text-gray-400 mb-2">Letzte Health-Checks</h3>
                {Object.keys(detail.health).length === 0 ? (
                  <div className="text-xs text-gray-600">Noch keine Probes gelaufen.</div>
                ) : (
                  <div className="space-y-1">
                    {(['git', 'build', 'deps', 'http'] as HealthProbe[]).map(probe => {
                      const entry = detail.health[probe];
                      if (!entry) return null;
                      return (
                        <div key={probe} className="flex items-start gap-2 text-xs">
                          <span className={`${HEALTH_COLOR[entry.status]} font-mono`}>{HEALTH_ICON[entry.status]}</span>
                          <span className="text-gray-400 font-mono w-12">{probe}</span>
                          <span className={`${HEALTH_COLOR[entry.status]} w-16`}>{entry.status}</span>
                          <span className="text-gray-600 w-12">{relativeTime(entry.checkedAt)}</span>
                          <span className="text-gray-500 flex-1 break-words">{entry.details}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Open Items */}
              <div className="pt-2 border-t border-[#222]">
                <h3 className="text-sm font-semibold text-gray-400 mb-2">Offene Punkte ({detail.openItems.filter(it => it.status === 'open').length})</h3>
                <div className="space-y-1 mb-2">
                  {detail.openItems.filter(it => it.status === 'open').map(it => (
                    <div key={it.id} className="flex items-center gap-2 text-sm">
                      <button onClick={() => resolveOpenItem(it)} className="text-gray-500 hover:text-emerald-400" title="Erledigen">☐</button>
                      <span>{priorityIcon(it.priority)}</span>
                      <span className="text-gray-300 flex-1">{it.title}</span>
                      <span className="text-[10px] text-gray-600">{relativeTime(it.createdAt)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input value={newItemTitle} onChange={e => setNewItemTitle(e.target.value)} placeholder="Neuer Punkt..." className="flex-1 px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-xs text-gray-200" />
                  <select value={newItemPriority} onChange={e => setNewItemPriority(e.target.value as 'low' | 'normal' | 'high')} className="px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-xs text-gray-200">
                    <option value="low">low</option>
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                  </select>
                  <button onClick={addOpenItem} className="px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded border border-emerald-500/30 text-xs">+</button>
                </div>
              </div>

              {/* Sessions */}
              {detail.sessions.length > 0 && (
                <div className="pt-2 border-t border-[#222]">
                  <h3 className="text-sm font-semibold text-gray-400 mb-2">Letzte Sessions ({detail.sessions.length})</h3>
                  <div className="space-y-1.5">
                    {detail.sessions.slice(0, 10).map(s => (
                      <div key={s.id} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 text-[10px] bg-[#1a1a1a] text-gray-400 border border-[#2a2a2a] rounded font-mono">{s.sessionType}</span>
                          <span className="text-gray-500">{relativeTime(s.startedAt)}</span>
                          {s.summary?.status && <span className={`text-[10px] ${s.summary.status === 'success' ? 'text-emerald-400' : s.summary.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>{s.summary.status}</span>}
                        </div>
                        {s.summary?.whatWasDone && <div className="text-gray-400 mt-0.5 ml-1">{s.summary.whatWasDone}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Decisions */}
              {detail.decisions.length > 0 && (
                <div className="pt-2 border-t border-[#222]">
                  <h3 className="text-sm font-semibold text-gray-400 mb-2">Entscheidungen ({detail.decisions.length})</h3>
                  <div className="space-y-1.5">
                    {detail.decisions.slice(0, 10).map(d => (
                      <div key={d.id} className="text-xs">
                        <div className="text-gray-300 font-medium">{d.choice}</div>
                        {d.rationale && <div className="text-gray-500 mt-0.5 ml-2 italic">{d.rationale}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
