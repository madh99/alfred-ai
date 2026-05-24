'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type {
  Project, ProjectDetail, ProjectStatus, ProjectHealthMode, ProjectOpenItem,
  HealthProbe,
} from '@/lib/alfred-client';
import { AuditModal } from './AuditModal';
import { ProjectChat } from './ProjectChat';
import { RunningAgentsBanner } from './RunningAgentsBanner';
import { ProjectWorkStatsView } from './ProjectWorkStatsView';
import { ProjectDeployModal } from './ProjectDeployModal';
import { ProjectConventionsView } from './ProjectConventionsView';
import { ProjectRoadmapView } from './ProjectRoadmapView';
import { ProjectAutomationsView } from './ProjectAutomationsView';
import { ProjectEnvironmentsView } from './ProjectEnvironmentsView';
import { ProjectDbSeedsView } from './ProjectDbSeedsView';
import { ProjectSandboxesView } from './ProjectSandboxesView';
import { SandboxQuickCreateModal } from './SandboxQuickCreateModal';
import { ProjectStorageView } from './ProjectStorageView';

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

// v643 — Repo-URL Helpers
function repoIconFor(url: string): string {
  if (/github\.com/.test(url)) return '🐙';
  if (/gitlab/.test(url)) return '🦊';
  if (/gitea/.test(url)) return '🍵';
  if (/bitbucket/.test(url)) return '🪣';
  return '🔗';
}
function shortRepoUrl(url: string): string {
  // strip protocol + .git suffix; keep last 2 path segments
  return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
}
function commitUrlFor(repoUrl: string | undefined, sha: string): string | undefined {
  if (!repoUrl) return undefined;
  const base = repoUrl.replace(/\.git$/, '');
  if (/github\.com|gitlab|gitea|bitbucket/.test(base)) return `${base}/commit/${sha}`;
  return undefined;
}

export function ProjectsPage() {
  const { client } = useConfig();
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [tab, setTab] = useState<'projects' | 'consultations'>('projects');
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
  // v641 — Multi-Select + Bulk-Work + Audit
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [workingOnItems, setWorkingOnItems] = useState(false);
  const [auditing, setAuditing] = useState(false);
  // v642 — strukturiertes Audit-Modal
  const [auditData, setAuditData] = useState<any | null>(null);
  // v654 — Expandable Item-Details + Erledigt-Section
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(new Set());
  const [showResolvedItems, setShowResolvedItems] = useState(false);
  // v659 — Deploy-Modal
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  // v735 — Sandbox-Quick-Create
  const [sandboxModalOpen, setSandboxModalOpen] = useState(false);
  // v668 — Roadmap-Edit pro Open-Item (Inline statt Modal)
  const [roadmapEditId, setRoadmapEditId] = useState<string | null>(null);
  const [roadmapForm, setRoadmapForm] = useState<{ milestone: string; order: string; estimatedHours: string }>({ milestone: '', order: '', estimatedHours: '' });
  // v704 — Inline-Edit für Title + Description
  const [itemEditId, setItemEditId] = useState<string | null>(null);
  const [itemEditForm, setItemEditForm] = useState<{ title: string; description: string }>({ title: '', description: '' });

  function startItemEdit(item: { id: string; title: string; description?: string | null }) {
    setItemEditId(item.id);
    setItemEditForm({ title: item.title, description: item.description ?? '' });
    setExpandedItemIds(prev => { const next = new Set(prev); next.add(item.id); return next; });
  }

  async function saveItemEdit(itemId: string) {
    if (!client) return;
    const ok = await client.patchProjectOpenItem(itemId, {
      title: itemEditForm.title.trim(),
      description: itemEditForm.description.trim() || null,
    });
    if (ok && detail) {
      setDetail({
        ...detail,
        openItems: detail.openItems.map(it => it.id === itemId
          ? { ...it, title: itemEditForm.title.trim(), description: itemEditForm.description.trim() || undefined }
          : it),
      });
    }
    setItemEditId(null);
  }

  function toggleItemExpanded(id: string) {
    setExpandedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function formatDateTime(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function isOverdue(iso?: string): boolean {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
  }

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

  // v647 — Deep-Link: ?id=<projectId> auto-selektiert
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const idParam = params.get('id');
      if (idParam) setSelectedId(idParam);
    } catch { /* skip */ }
  }, []);

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

  // v668 — Open-Item zur Roadmap hinzufügen / aus der Roadmap entfernen
  function openRoadmapEdit(item: ProjectOpenItem) {
    setRoadmapForm({
      milestone: item.roadmapMilestone ?? '',
      order: item.roadmapOrder != null ? String(item.roadmapOrder) : '',
      estimatedHours: item.estimatedHours != null ? String(item.estimatedHours) : '',
    });
    setRoadmapEditId(item.id);
  }
  async function saveRoadmap(itemId: string) {
    if (!client || !detail) return;
    const milestone = roadmapForm.milestone.trim();
    const order = roadmapForm.order.trim() === '' ? null : Number.parseInt(roadmapForm.order, 10);
    const estimatedHours = roadmapForm.estimatedHours.trim() === '' ? null : Number.parseFloat(roadmapForm.estimatedHours);
    const ok = await client.updateOpenItemRoadmap(itemId, {
      milestone: milestone === '' ? null : milestone,
      order: order != null && Number.isFinite(order) ? order : null,
      estimatedHours: estimatedHours != null && Number.isFinite(estimatedHours) ? estimatedHours : null,
    });
    if (ok) {
      setDetail({
        ...detail,
        openItems: detail.openItems.map(it => it.id === itemId ? {
          ...it,
          roadmapMilestone: milestone === '' ? undefined : milestone,
          roadmapOrder: order != null && Number.isFinite(order) ? order : undefined,
          estimatedHours: estimatedHours != null && Number.isFinite(estimatedHours) ? estimatedHours : undefined,
        } : it),
      });
      setRoadmapEditId(null);
    }
  }

  function toggleItemSelect(id: string) {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function bulkWorkOnSelected() {
    if (!client || !detail || selectedItemIds.size === 0) return;
    if (!confirm(`Project-Agent mit ${selectedItemIds.size} ausgewählten Items als Goal starten?`)) return;
    setWorkingOnItems(true);
    try {
      const r = await client.projectWorkOnOpenItems(detail.project.id, [...selectedItemIds]);
      if (r.ok) {
        alert(`▶ Project-Agent gestartet${r.taskId ? ` (taskId ${r.taskId.slice(0, 8)})` : ''}.\nNach Abschluss prüft Alfred automatisch welche Items erledigt wurden.`);
        setSelectedItemIds(new Set());
      } else {
        alert(`Fehler: ${r.reason}`);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setWorkingOnItems(false); }
  }

  async function runAudit() {
    if (!client || !detail) return;
    setAuditing(true); setAuditData(null);
    try {
      const r = await client.projectAuditOpenItems(detail.project.id);
      if (r.data) setAuditData(r.data);
      else alert(r.display ?? 'Audit lieferte keine Daten');
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setAuditing(false); }
  }

  async function handleAuditBulkClose(ids: string[]) {
    if (!client || !detail) return;
    const r = await client.projectBulkCloseItems(detail.project.id, ids);
    alert(`${r.closed}/${ids.length} Items als erledigt markiert${r.failed.length > 0 ? `\n${r.failed.length} fehlgeschlagen` : ''}`);
    await loadDetail(detail.project.id);
    // Refresh audit data
    const r2 = await client.projectAuditOpenItems(detail.project.id);
    if (r2.data) setAuditData(r2.data);
  }

  async function handleAuditBulkWork(ids: string[]) {
    if (!client || !detail) return;
    const r = await client.projectWorkOnOpenItems(detail.project.id, ids);
    if (r.ok) {
      alert(`▶ Project-Agent gestartet${r.taskId ? ` (taskId ${r.taskId.slice(0, 8)})` : ''}.\nNach Abschluss prüft Alfred automatisch welche Items erledigt wurden.`);
      setAuditData(null);
    } else {
      alert(`Fehler: ${r.reason}`);
    }
  }

  // v602 P5 — Tabs trennen normale Projekte vom Misc-Sammel-Bucket.
  // Backend speichert beide als 'projects', das Frontend trennt visuell:
  // 'projects' Tab → alles AUSSER Misc-Bucket
  // 'consultations' Tab → NUR Misc-Bucket (slug='misc' oder tags enthalten 'system')
  const isMiscBucket = (p: Project): boolean =>
    p.slug === 'misc' || p.tags.includes('system');

  const visible = projects
    .filter(p => tab === 'consultations' ? isMiscBucket(p) : !isMiscBucket(p))
    .filter(p => !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (p.cwd ?? '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));

  const miscCount = projects.filter(isMiscBucket).length;
  const projectsCount = projects.length - miscCount;

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

      <div className="flex gap-2 mb-4 border-b border-[#222]">
        <button
          onClick={() => { setTab('projects'); setSelectedId(null); }}
          className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === 'projects' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
        >
          Projekte ({projectsCount})
        </button>
        <button
          onClick={() => { setTab('consultations'); setSelectedId(null); }}
          className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === 'consultations' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
        >
          Beratungs-Sessions ({miscCount})
        </button>
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

      {/* v688 — Info-Banner: laufende Project-Agent/Code-Agent-Sessions */}
      <RunningAgentsBanner />

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
                  {/* v735 — Sandbox-Quick-Create direkt aus Project-Detail */}
                  {detail.project.status !== 'archived' && (
                    <button
                      onClick={() => setSandboxModalOpen(true)}
                      className="px-3 py-1 text-xs text-cyan-400 hover:bg-cyan-500/10 rounded border border-cyan-500/30"
                      title="Sandbox erstellen mit ENV-Stage + DB-Seed-Wahl"
                    >🧪 Sandbox</button>
                  )}
                  {/* v659 — Deploy-Trigger */}
                  {detail.project.status !== 'archived' && (
                    <button
                      onClick={() => setDeployModalOpen(true)}
                      className="px-3 py-1 text-xs text-blue-400 hover:bg-blue-500/10 rounded border border-blue-500/30"
                      title="Deploy mit konfigurierbaren Parametern (pm2/docker/systemd, host, user, port)"
                    >🚀 Deploy</button>
                  )}
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
              {detail.project.repoUrl && (
                <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  <span className="text-gray-600">repo:</span>
                  <a href={detail.project.repoUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline inline-flex items-center gap-1">
                    <span>{repoIconFor(detail.project.repoUrl)}</span>
                    <span>{shortRepoUrl(detail.project.repoUrl)}</span>
                    <span className="text-[10px] text-gray-600">↗</span>
                  </a>
                  {detail.project.defaultBranch && (
                    <span className="text-[10px] text-gray-600 border border-[#2a2a2a] rounded px-1.5 py-0.5">
                      ⎇ {detail.project.defaultBranch}
                    </span>
                  )}
                </div>
              )}

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

              {/* Open Items — v654: open + in_progress in einer Liste, expandable Details */}
              <div className="pt-2 border-t border-[#222]">
                {(() => {
                  const activeItems = detail.openItems.filter(it => it.status === 'open' || it.status === 'in_progress');
                  const resolvedItems = detail.openItems
                    .filter(it => it.status === 'done' || it.status === 'cancelled')
                    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
                  return (
                <>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-400">Offene Punkte ({activeItems.length})</h3>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={runAudit}
                      disabled={auditing}
                      className="px-2 py-0.5 text-[10px] text-blue-400 hover:bg-blue-500/10 border border-blue-500/30 rounded disabled:opacity-60 disabled:cursor-wait"
                      title={auditing ? 'Audit läuft — LLM prüft Items auf Stale/Duplikate/Erledigt' : 'Stale + Duplikate + möglicherweise-erledigte finden'}
                    >{auditing ? '⏳ Audit läuft…' : '🔍 Audit'}</button>
                  </div>
                </div>
                {/* v668 — Audit-Loading-Banner: User sieht sofort dass etwas passiert */}
                {auditing && (
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded px-3 py-2 mb-2 text-xs text-blue-200 flex items-center gap-2 animate-pulse">
                    <span>⏳</span>
                    <span>Audit läuft… LLM prüft alle offenen Items auf Stale-Indikatoren, Duplikate und mögliche Auto-Resolves. Das kann 10–30 Sekunden dauern.</span>
                  </div>
                )}

                {/* Bulk-Toolbar */}
                {selectedItemIds.size > 0 && (
                  <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded px-2 py-1.5 mb-2">
                    <span className="text-xs text-blue-200"><strong>{selectedItemIds.size}</strong> ausgewählt</span>
                    <div className="flex-1" />
                    <button onClick={() => setSelectedItemIds(new Set())} className="text-[10px] text-gray-400 hover:text-gray-200">Auswahl löschen</button>
                    <button
                      onClick={bulkWorkOnSelected}
                      disabled={workingOnItems}
                      className="px-2 py-0.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
                    >{workingOnItems ? 'Starte …' : '▶ Mit Project-Agent abarbeiten'}</button>
                  </div>
                )}

                <div className="space-y-1 mb-2">
                  {activeItems.map(it => {
                    const possiblyDone = it.autoResolvedBy && it.autoResolvedConfidence != null;
                    const isExpanded = expandedItemIds.has(it.id);
                    const hasDetails = !!(it.description || it.dueAt || it.linkedIncidentId || it.linkedChangeId || it.sessionId || it.autoResolvedBy);
                    const overdue = isOverdue(it.dueAt);
                    return (
                      <div key={it.id} className={selectedItemIds.has(it.id) ? 'bg-blue-500/10 -mx-1 px-1 rounded' : ''}>
                        <div className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selectedItemIds.has(it.id)}
                            onChange={() => toggleItemSelect(it.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mr-0"
                            title="Für Bulk-Aktion auswählen"
                          />
                          <button onClick={() => resolveOpenItem(it)} className="text-gray-500 hover:text-emerald-400" title="Erledigen">☐</button>
                          <button
                            onClick={() => startItemEdit(it)}
                            className="text-gray-600 hover:text-amber-400"
                            title="Titel + Beschreibung bearbeiten"
                          >✏️</button>
                          <button
                            onClick={() => openRoadmapEdit(it)}
                            className={it.roadmapMilestone ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-blue-400'}
                            title={it.roadmapMilestone ? `Roadmap: ${it.roadmapMilestone}${it.roadmapOrder != null ? ` #${it.roadmapOrder}` : ''}` : 'Zur Roadmap hinzufügen'}
                          >🗺️</button>
                          <span title={it.status === 'in_progress' ? 'in Bearbeitung' : it.priority}>
                            {it.status === 'in_progress' ? '🔄' : priorityIcon(it.priority)}
                          </span>
                          <button
                            onClick={() => hasDetails && toggleItemExpanded(it.id)}
                            className={`flex-1 text-left ${hasDetails ? 'text-gray-300 hover:text-gray-100 cursor-pointer' : 'text-gray-300 cursor-default'}`}
                            title={hasDetails ? (isExpanded ? 'Details ausblenden' : 'Details anzeigen') : ''}
                          >
                            {hasDetails && <span className="text-gray-600 mr-1">{isExpanded ? '▾' : '▸'}</span>}
                            {it.title}
                          </button>
                          {overdue && (
                            <span className="text-[10px] text-red-400" title={`Fällig: ${formatDateTime(it.dueAt)}`}>⏰ überfällig</span>
                          )}
                          {possiblyDone && (
                            <span
                              className="text-[10px] text-amber-400 cursor-help"
                              title={`Alfred meint: vermutlich erledigt (${Math.round((it.autoResolvedConfidence ?? 0) * 100)}%) durch ${it.autoResolvedBy?.slice(0, 80)}`}
                            >🤖 ~{Math.round((it.autoResolvedConfidence ?? 0) * 100)}%</span>
                          )}
                          {it.linkedTodoId && (
                            <a href="/todos" className="text-[10px] text-blue-300" title="Verknüpft mit Todo (Status-Sync aktiv)">🔗</a>
                          )}
                          <span className="text-[10px] text-gray-600">{relativeTime(it.createdAt)}</span>
                        </div>
                        {/* v668 — Roadmap-Edit Inline-Form */}
                        {itemEditId === it.id && (
                          <div className="ml-12 mt-1 mb-2 p-2 bg-amber-500/5 border border-amber-500/30 rounded text-[11px] space-y-1.5">
                            <div className="text-amber-300 font-semibold text-[10px]">✏️ Item bearbeiten</div>
                            <input
                              value={itemEditForm.title}
                              onChange={e => setItemEditForm(f => ({ ...f, title: e.target.value }))}
                              placeholder="Titel"
                              className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200"
                            />
                            <textarea
                              value={itemEditForm.description}
                              onChange={e => setItemEditForm(f => ({ ...f, description: e.target.value }))}
                              placeholder="Beschreibung (optional)"
                              rows={4}
                              className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 resize-y font-mono text-[10px]"
                            />
                            <div className="flex gap-1.5 justify-end">
                              <button
                                onClick={() => setItemEditId(null)}
                                className="px-2 py-0.5 text-gray-400 hover:text-gray-200"
                              >Abbrechen</button>
                              <button
                                onClick={() => saveItemEdit(it.id)}
                                disabled={!itemEditForm.title.trim()}
                                className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 rounded hover:bg-amber-500/30 disabled:opacity-50"
                              >Speichern</button>
                            </div>
                          </div>
                        )}
                        {roadmapEditId === it.id && (
                          <div className="ml-12 mt-1 mb-2 p-2 bg-[#0f0f0f] border border-blue-500/30 rounded text-[11px] space-y-1.5">
                            <div className="text-blue-300 font-semibold">🗺️ Roadmap-Zuordnung</div>
                            <div className="flex gap-1.5">
                              <input
                                value={roadmapForm.milestone}
                                onChange={e => setRoadmapForm(f => ({ ...f, milestone: e.target.value }))}
                                placeholder="Milestone (z.B. v2.0, Beta, Q3-2026)"
                                className="flex-1 px-2 py-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200"
                              />
                              <input
                                value={roadmapForm.order}
                                onChange={e => setRoadmapForm(f => ({ ...f, order: e.target.value }))}
                                placeholder="Reihenfolge"
                                inputMode="numeric"
                                className="w-20 px-2 py-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200"
                              />
                              <input
                                value={roadmapForm.estimatedHours}
                                onChange={e => setRoadmapForm(f => ({ ...f, estimatedHours: e.target.value }))}
                                placeholder="Stunden"
                                inputMode="decimal"
                                className="w-20 px-2 py-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200"
                              />
                            </div>
                            <div className="flex gap-1.5 justify-end">
                              <button
                                onClick={() => setRoadmapEditId(null)}
                                className="px-2 py-0.5 text-gray-400 hover:text-gray-200"
                              >Abbrechen</button>
                              <button
                                onClick={() => saveRoadmap(it.id)}
                                className="px-2 py-0.5 bg-blue-500/20 border border-blue-500/40 text-blue-300 rounded hover:bg-blue-500/30"
                              >Speichern</button>
                              {it.roadmapMilestone && (
                                <button
                                  onClick={() => { setRoadmapForm({ milestone: '', order: '', estimatedHours: '' }); saveRoadmap(it.id); }}
                                  className="px-2 py-0.5 bg-red-500/10 border border-red-500/30 text-red-300 rounded hover:bg-red-500/20"
                                >Aus Roadmap entfernen</button>
                              )}
                            </div>
                            <div className="text-[10px] text-gray-500">
                              Leer lassen = keine Roadmap-Position. Reihenfolge bestimmt Sortierung innerhalb des Milestones.
                            </div>
                          </div>
                        )}
                        {isExpanded && hasDetails && (
                          <div className="ml-12 mt-1 mb-2 text-[11px] text-gray-400 space-y-0.5 border-l border-[#2a2a2a] pl-2">
                            {it.description && (
                              <div className="text-gray-300 whitespace-pre-wrap">{it.description}</div>
                            )}
                            {it.dueAt && (
                              <div>
                                <span className="text-gray-500">Fällig:</span>{' '}
                                <span className={overdue ? 'text-red-400' : 'text-gray-300'}>{formatDateTime(it.dueAt)}</span>
                              </div>
                            )}
                            {it.linkedIncidentId && (
                              <div>
                                <span className="text-gray-500">Incident:</span>{' '}
                                <a href={`/itsm?incident=${it.linkedIncidentId}`} className="text-blue-400 hover:underline font-mono">{it.linkedIncidentId.slice(0, 8)}</a>
                              </div>
                            )}
                            {it.linkedChangeId && (
                              <div>
                                <span className="text-gray-500">Change:</span>{' '}
                                <a href={`/itsm?change=${it.linkedChangeId}`} className="text-blue-400 hover:underline font-mono">{it.linkedChangeId.slice(0, 8)}</a>
                              </div>
                            )}
                            {it.linkedTodoId && (
                              <div>
                                <span className="text-gray-500">Verknüpftes Todo:</span>{' '}
                                <a href={`/todos`} className="text-blue-400 hover:underline font-mono" title="Spiegel-Eintrag im Todos-Bereich (Status synchronisiert in beide Richtungen, Notizen am Todo)">🔗 {it.linkedTodoId.slice(0, 8)}</a>
                              </div>
                            )}
                            {it.sessionId && (
                              <div>
                                <span className="text-gray-500">Session:</span>{' '}
                                <a href={`/project-agents?task=${it.sessionId}`} className="text-blue-400 hover:underline font-mono">{it.sessionId.slice(0, 8)}</a>
                              </div>
                            )}
                            {it.autoResolvedBy && (
                              <div>
                                <span className="text-gray-500">Auto-Resolve-Quelle:</span>{' '}
                                <span className="text-amber-300">{it.autoResolvedBy}</span>
                                {it.autoResolvedConfidence != null && (
                                  <span className="text-gray-500"> ({Math.round(it.autoResolvedConfidence * 100)}%)</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
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

                {/* v654 — Erledigt-Section (default collapsed) */}
                {resolvedItems.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-[#222]">
                    <button
                      onClick={() => setShowResolvedItems(v => !v)}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 mb-1"
                    >
                      <span>{showResolvedItems ? '▾' : '▸'}</span>
                      <span>Erledigt ({resolvedItems.length}{resolvedItems[0]?.resolvedAt ? ` — zuletzt vor ${relativeTime(resolvedItems[0].resolvedAt)}` : ''})</span>
                    </button>
                    {showResolvedItems && (
                      <div className="space-y-0.5">
                        {resolvedItems.slice(0, 50).map(it => {
                          const isAuto = !!it.autoResolvedBy;
                          const isCancelled = it.status === 'cancelled';
                          const isExpanded = expandedItemIds.has(it.id);
                          const hasDetails = !!(it.description || it.linkedIncidentId || it.linkedChangeId || it.sessionId || it.autoResolvedBy);
                          return (
                            <div key={it.id}>
                              <div className="flex items-center gap-2 text-xs">
                                <span className="w-4 text-center" title={isCancelled ? 'verworfen' : 'erledigt'}>{isCancelled ? '✖' : '☑'}</span>
                                <span className="opacity-50">{priorityIcon(it.priority)}</span>
                                <button
                                  onClick={() => hasDetails && toggleItemExpanded(it.id)}
                                  className={`flex-1 text-left line-through opacity-60 ${hasDetails ? 'hover:opacity-100 cursor-pointer' : 'cursor-default'} ${isCancelled ? 'text-gray-500' : 'text-gray-400'}`}
                                  title={hasDetails ? (isExpanded ? 'Details ausblenden' : 'Details anzeigen') : ''}
                                >
                                  {hasDetails && <span className="text-gray-600 mr-1 no-underline inline-block">{isExpanded ? '▾' : '▸'}</span>}
                                  {it.title}
                                </button>
                                {isAuto && (
                                  <span className="text-[10px] text-amber-500/70" title={`Auto-resolved durch ${it.autoResolvedBy?.slice(0, 80)}${it.autoResolvedConfidence != null ? ` (${Math.round(it.autoResolvedConfidence * 100)}%)` : ''}`}>🤖</span>
                                )}
                                <span className="text-[10px] text-gray-600" title={it.resolvedAt ? `Erledigt: ${formatDateTime(it.resolvedAt)}` : ''}>
                                  {it.resolvedAt ? formatDateTime(it.resolvedAt) : '—'}
                                </span>
                              </div>
                              {isExpanded && hasDetails && (
                                <div className="ml-10 mt-0.5 mb-1 text-[11px] text-gray-500 space-y-0.5 border-l border-[#222] pl-2">
                                  {it.description && (
                                    <div className="text-gray-400 whitespace-pre-wrap">{it.description}</div>
                                  )}
                                  {it.linkedIncidentId && (
                                    <div>
                                      <span className="text-gray-600">Incident:</span>{' '}
                                      <a href={`/itsm?incident=${it.linkedIncidentId}`} className="text-blue-400 hover:underline font-mono">{it.linkedIncidentId.slice(0, 8)}</a>
                                    </div>
                                  )}
                                  {it.linkedChangeId && (
                                    <div>
                                      <span className="text-gray-600">Change:</span>{' '}
                                      <a href={`/itsm?change=${it.linkedChangeId}`} className="text-blue-400 hover:underline font-mono">{it.linkedChangeId.slice(0, 8)}</a>
                                    </div>
                                  )}
                                  {it.sessionId && (
                                    <div>
                                      <span className="text-gray-600">Session:</span>{' '}
                                      <a href={`/project-agents?task=${it.sessionId}`} className="text-blue-400 hover:underline font-mono">{it.sessionId.slice(0, 8)}</a>
                                    </div>
                                  )}
                                  {it.autoResolvedBy && (
                                    <div>
                                      <span className="text-gray-600">Auto-Resolve:</span>{' '}
                                      <span className="text-amber-400/80">{it.autoResolvedBy}</span>
                                      {it.autoResolvedConfidence != null && (
                                        <span className="text-gray-600"> ({Math.round(it.autoResolvedConfidence * 100)}%)</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {resolvedItems.length > 50 && (
                          <div className="text-[10px] text-gray-600 mt-1">+{resolvedItems.length - 50} weitere</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                </>
                );
                })()}
              </div>

              {auditData && (
                <AuditModal
                  data={auditData}
                  onClose={() => setAuditData(null)}
                  onBulkClose={handleAuditBulkClose}
                  onBulkWork={handleAuditBulkWork}
                />
              )}

              {/* Sessions */}
              {detail.sessions.length > 0 && (
                <div className="pt-2 border-t border-[#222]">
                  <h3 className="text-sm font-semibold text-gray-400 mb-2">Letzte Sessions ({detail.sessions.length})</h3>
                  <div className="space-y-1.5">
                    {detail.sessions.slice(0, 10).map(s => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        projectId={detail.project.id}
                        repoUrl={detail.project.repoUrl}
                      />
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

              {/* v665b — Storage-View (collapsible) */}
              <ProjectStorageView project={detail.project} onMoved={() => loadDetail(detail.project.id)} />

              {/* v663a — Roadmap-View (collapsible) */}
              <ProjectRoadmapView projectId={detail.project.id} projectName={detail.project.name} />

              {/* v663b — Automations-View (collapsible) */}
              <ProjectAutomationsView projectId={detail.project.id} projectName={detail.project.name} />

              {/* v732 — Environments-View (collapsible) */}
              <ProjectEnvironmentsView projectId={detail.project.id} projectName={detail.project.name} />

              {/* v732 — DB-Seeds-View (collapsible) */}
              <ProjectDbSeedsView projectId={detail.project.id} projectName={detail.project.name} defaultSeedId={detail.project.defaultDbSeedId ?? null} />

              {/* v737 — Sandboxes-Übersicht mit Quick-Actions */}
              <ProjectSandboxesView projectId={detail.project.id} projectName={detail.project.name} />

              {/* v663a — Conventions (collapsible) */}
              <ProjectConventionsView
                project={detail.project}
                onSaved={(p) => setDetail({ ...detail, project: p })}
              />

              {/* v658 — Work-Stats (collapsible) */}
              <ProjectWorkStatsView projectId={detail.project.id} />

              {/* v658 — Projekt-Chat-Pane (collapsible) */}
              <ProjectChat projectId={detail.project.id} projectName={detail.project.name} />

              {/* v659 — Deploy-Modal */}
              {deployModalOpen && (
                <ProjectDeployModal
                  projectId={detail.project.id}
                  projectName={detail.project.name}
                  defaultRepoUrl={detail.project.repoUrl}
                  onClose={() => setDeployModalOpen(false)}
                />
              )}

              {/* v735 — Sandbox-Quick-Create-Modal */}
              {sandboxModalOpen && (
                <SandboxQuickCreateModal
                  projectId={detail.project.id}
                  projectName={detail.project.name}
                  onClose={() => setSandboxModalOpen(false)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// v643 — SessionRow mit Commit-Expander
import type { ProjectCommit, ProjectSession } from '@/lib/alfred-client';

function SessionRow({ session, projectId, repoUrl }: { session: ProjectSession; projectId: string; repoUrl?: string }) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState<ProjectCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const sourceId = (session as any).sourceId as string | undefined;

  async function toggle() {
    setExpanded(e => !e);
    if (expanded || loaded || !client || !sourceId) return;
    setLoading(true);
    try {
      const list = await client.fetchSessionCommits(projectId, sourceId);
      setCommits(list);
      setLoaded(true);
    } catch { /* skip */ }
    finally { setLoading(false); }
  }

  return (
    <div className="text-xs border border-transparent hover:border-[#2a2a2a] rounded p-1.5 -mx-1.5">
      <div className="flex items-center gap-2 cursor-pointer" onClick={toggle}>
        <span className="text-gray-500 text-[10px]">{expanded ? '▼' : '▶'}</span>
        <span className="px-1.5 py-0.5 text-[10px] bg-[#1a1a1a] text-gray-400 border border-[#2a2a2a] rounded font-mono">{session.sessionType}</span>
        <span className="text-gray-500">{relativeTime(session.startedAt)}</span>
        {session.summary?.status && (
          <span className={`text-[10px] ${session.summary.status === 'success' ? 'text-emerald-400' : session.summary.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>{session.summary.status}</span>
        )}
      </div>
      {session.summary?.whatWasDone && <div className="text-gray-400 mt-0.5 ml-5">{session.summary.whatWasDone}</div>}
      {expanded && (
        <div className="ml-5 mt-1 space-y-0.5">
          {loading && <div className="text-gray-500 text-[10px]">Lade Commits …</div>}
          {!loading && commits.length === 0 && loaded && <div className="text-gray-600 text-[10px] italic">Keine Commits gefunden für diese Session.</div>}
          {commits.map(c => {
            const url = commitUrlFor(repoUrl, c.sha);
            return (
              <div key={c.id} className="flex items-center gap-1.5 text-[11px]">
                <span className="text-gray-600 font-mono text-[10px]">{c.phaseIdx ? `P${c.phaseIdx}` : '—'}</span>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline font-mono text-[10px]">{c.sha.slice(0, 8)}</a>
                ) : (
                  <span className="text-gray-500 font-mono text-[10px]">{c.sha.slice(0, 8)}</span>
                )}
                <span className="text-gray-300 truncate flex-1">{c.message.slice(0, 80)}</span>
                {c.filesChanged > 0 && <span className="text-gray-600">·{c.filesChanged}f</span>}
                {c.pushedAt && <span className="text-emerald-500/70 text-[10px]" title={c.pushedAt}>↑</span>}
              </div>
            );
          })}
          {(session as any).lastPushUrl && (
            <div className="pt-1 border-t border-[#222] mt-1">
              <a href={(session as any).lastPushUrl} target="_blank" rel="noreferrer" className="text-purple-400 hover:underline text-[10px] inline-flex items-center gap-1">
                🔀 MR/PR öffnen ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
