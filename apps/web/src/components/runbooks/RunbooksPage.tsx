'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { Runbook } from '@/lib/alfred-client';

const STATUS_BADGES: Record<string, string> = {
  draft: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  verified: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  deprecated: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
};

const SOURCE_LABELS: Record<string, string> = {
  itsm_incident: 'ITSM',
  project_agent: 'Project',
  chat_session: 'Chat',
  manual: 'Manual',
};

export function RunbooksPage() {
  const { client } = useConfig();
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [selected, setSelected] = useState<Runbook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterSource, setFilterSource] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [editStepsRaw, setEditStepsRaw] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editSymptom, setEditSymptom] = useState('');
  const [editCause, setEditCause] = useState('');
  const [editVerification, setEditVerification] = useState('');
  const [editRollback, setEditRollback] = useState('');
  const [editTags, setEditTags] = useState('');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchRunbooks();
      setRunbooks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  function startEdit(rb: Runbook) {
    setSelected(rb);
    setEditing(true);
    setEditTitle(rb.title);
    setEditSymptom(rb.symptom ?? '');
    setEditCause(rb.cause ?? '');
    setEditStepsRaw(rb.steps.join('\n'));
    setEditVerification(rb.verification ?? '');
    setEditRollback(rb.rollback ?? '');
    setEditTags(rb.tags.join(', '));
  }

  async function saveEdit() {
    if (!client || !selected) return;
    const patch = {
      title: editTitle,
      symptom: editSymptom,
      cause: editCause,
      steps: editStepsRaw.split('\n').map(s => s.trim()).filter(s => s.length > 0),
      verification: editVerification,
      rollback: editRollback,
      tags: editTags.split(',').map(t => t.trim()).filter(t => t.length > 0),
    };
    const updated = await client.updateRunbook(selected.id, patch);
    if (updated) {
      setRunbooks(prev => prev.map(rb => rb.id === updated.id ? updated : rb));
      setSelected(updated);
      setEditing(false);
    } else {
      alert('Speichern fehlgeschlagen.');
    }
  }

  async function setStatus(rb: Runbook, status: 'draft' | 'verified' | 'deprecated') {
    if (!client) return;
    const updated = await client.updateRunbook(rb.id, { status });
    if (updated) {
      setRunbooks(prev => prev.map(x => x.id === updated.id ? updated : x));
      if (selected?.id === updated.id) setSelected(updated);
    }
  }

  async function handleDelete(rb: Runbook) {
    if (!client) return;
    if (!confirm(`Runbook "${rb.title}" wirklich löschen?`)) return;
    const ok = await client.deleteRunbook(rb.id);
    if (ok) {
      setRunbooks(prev => prev.filter(x => x.id !== rb.id));
      if (selected?.id === rb.id) setSelected(null);
    } else {
      alert('Löschen fehlgeschlagen.');
    }
  }

  const visible = runbooks
    .filter(rb => filterStatus === 'all' || rb.status === filterStatus)
    .filter(rb => filterSource === 'all' || rb.sourceType === filterSource)
    .filter(rb => !search ||
      rb.title.toLowerCase().includes(search.toLowerCase()) ||
      (rb.symptom ?? '').toLowerCase().includes(search.toLowerCase()) ||
      rb.tags.some(t => t.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Runbooks</h1>
          <p className="text-sm text-gray-500 mt-1">
            Erfahrungsgedächtnis — wie wurden Aufgaben/Probleme/Entscheidungen früher gelöst.
          </p>
        </div>
        <button
          onClick={load}
          className="px-4 py-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg text-sm border border-blue-500/30"
        >
          Aktualisieren
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {['all', 'draft', 'verified', 'deprecated'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${filterStatus === s ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
          >
            {s === 'all' ? `Alle (${runbooks.length})` : s}
          </button>
        ))}
        <div className="w-4" />
        {['all', 'itsm_incident', 'project_agent', 'chat_session', 'manual'].map(s => (
          <button
            key={s}
            onClick={() => setFilterSource(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${filterSource === s ? 'bg-purple-500/20 text-purple-400 border-purple-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
          >
            {s === 'all' ? 'Alle Quellen' : (SOURCE_LABELS[s] ?? s)}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="Suchen in Titel, Symptom oder Tags..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none mb-4"
      />

      {loading && <div className="text-gray-500 text-sm">Lade...</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {!loading && visible.length === 0 && (
        <div className="text-gray-500 text-sm py-8 text-center">Keine Runbooks gefunden.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* List */}
        <div className="md:col-span-1 space-y-2 max-h-[80vh] overflow-y-auto">
          {visible.map(rb => (
            <div
              key={rb.id}
              onClick={() => { setSelected(rb); setEditing(false); }}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${selected?.id === rb.id ? 'bg-blue-500/10 border-blue-500/40' : 'bg-[#141414] border-[#222] hover:border-[#333]'}`}
            >
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={`px-1.5 py-0.5 text-[10px] uppercase font-mono rounded border ${STATUS_BADGES[rb.status] ?? STATUS_BADGES.draft}`}>
                  {rb.status}
                </span>
                {rb.sourceType && (
                  <span className="px-1.5 py-0.5 text-[10px] uppercase font-mono rounded bg-[#222] text-gray-500 border border-[#2a2a2a]">
                    {SOURCE_LABELS[rb.sourceType] ?? rb.sourceType}
                  </span>
                )}
                <span className="text-[10px] text-gray-600 font-mono ml-auto">{rb.id.slice(0, 8)}</span>
              </div>
              <div className="text-sm text-gray-200 font-medium mb-1">{rb.title}</div>
              {rb.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {rb.tags.slice(0, 4).map(t => (
                    <span key={t} className="px-1.5 py-0.5 text-[10px] bg-[#1a1a1a] text-gray-500 border border-[#2a2a2a] rounded">{t}</span>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-gray-600 mt-1.5">
                {rb.usageCount > 0 ? `${rb.usageCount}× verwendet · ` : ''}
                {rb.updatedAt?.slice(0, 10)}
              </div>
            </div>
          ))}
        </div>

        {/* Detail / Editor */}
        <div className="md:col-span-2 p-4 bg-[#141414] border border-[#222] rounded-lg min-h-[400px]">
          {!selected && (
            <div className="text-gray-500 text-sm text-center py-12">
              Wähle ein Runbook aus der Liste links.
            </div>
          )}
          {selected && !editing && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <h2 className="text-xl font-bold text-gray-100">{selected.title}</h2>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => startEdit(selected)} className="px-3 py-1 text-xs bg-blue-500/10 text-blue-400 rounded border border-blue-500/30 hover:bg-blue-500/20">Bearbeiten</button>
                  {selected.status !== 'verified' && (
                    <button onClick={() => setStatus(selected, 'verified')} className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded border border-emerald-500/30 hover:bg-emerald-500/20">✓ Verifizieren</button>
                  )}
                  {selected.status !== 'deprecated' && (
                    <button onClick={() => setStatus(selected, 'deprecated')} className="px-3 py-1 text-xs bg-gray-500/10 text-gray-400 rounded border border-gray-500/30 hover:bg-gray-500/20">Deprecate</button>
                  )}
                  <button onClick={() => handleDelete(selected)} className="px-3 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded">Löschen</button>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap text-[11px] text-gray-500 font-mono">
                <span>{selected.id}</span>
                <span>·</span>
                <span>Confidence {(selected.confidence * 100).toFixed(0)}%</span>
                <span>·</span>
                <span>{selected.usageCount}× verwendet</span>
                {selected.sourceType && <><span>·</span><span>Quelle: {SOURCE_LABELS[selected.sourceType]} ({selected.sourceId?.slice(0, 8) ?? '—'})</span></>}
              </div>
              {selected.symptom && <div><h3 className="text-sm font-semibold text-gray-400 mb-1">Symptom</h3><p className="text-sm text-gray-300 whitespace-pre-wrap">{selected.symptom}</p></div>}
              {selected.cause && <div><h3 className="text-sm font-semibold text-gray-400 mb-1">Ursache</h3><p className="text-sm text-gray-300 whitespace-pre-wrap">{selected.cause}</p></div>}
              {selected.steps.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-400 mb-1">Schritte</h3>
                  <ol className="list-decimal list-inside text-sm text-gray-300 space-y-1">
                    {selected.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                </div>
              )}
              {selected.verification && <div><h3 className="text-sm font-semibold text-gray-400 mb-1">Verifikation</h3><p className="text-sm text-gray-300 whitespace-pre-wrap">{selected.verification}</p></div>}
              {selected.rollback && <div><h3 className="text-sm font-semibold text-gray-400 mb-1">Rollback</h3><p className="text-sm text-gray-300 whitespace-pre-wrap">{selected.rollback}</p></div>}
              {selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-2 border-t border-[#222]">
                  {selected.tags.map(t => <span key={t} className="px-2 py-0.5 text-xs bg-[#1a1a1a] text-gray-400 border border-[#2a2a2a] rounded">{t}</span>)}
                </div>
              )}
            </div>
          )}
          {selected && editing && (
            <div className="space-y-3">
              <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Titel" className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-base font-bold" />
              <div><label className="text-xs text-gray-500">Symptom</label><textarea value={editSymptom} onChange={e => setEditSymptom(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm" rows={2} /></div>
              <div><label className="text-xs text-gray-500">Ursache</label><textarea value={editCause} onChange={e => setEditCause(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm" rows={2} /></div>
              <div><label className="text-xs text-gray-500">Schritte (einer pro Zeile)</label><textarea value={editStepsRaw} onChange={e => setEditStepsRaw(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm font-mono" rows={8} /></div>
              <div><label className="text-xs text-gray-500">Verifikation</label><textarea value={editVerification} onChange={e => setEditVerification(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm" rows={2} /></div>
              <div><label className="text-xs text-gray-500">Rollback</label><textarea value={editRollback} onChange={e => setEditRollback(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm" rows={2} /></div>
              <div><label className="text-xs text-gray-500">Tags (kommasepariert)</label><input value={editTags} onChange={e => setEditTags(e.target.value)} className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm" /></div>
              <div className="flex gap-2">
                <button onClick={saveEdit} className="px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/40 hover:bg-emerald-500/30 text-sm">Speichern</button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 bg-[#1a1a1a] text-gray-400 rounded border border-[#2a2a2a] hover:bg-[#222] text-sm">Abbrechen</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
