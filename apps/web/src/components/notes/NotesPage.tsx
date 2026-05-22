'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { NoteItem, TodoItem } from '@/lib/alfred-client';
import { AttachmentSection } from '@/components/attachments/AttachmentSection';

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function NotesPage() {
  const { client } = useConfig();
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<NoteItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  // v672 — Verknüpfte Todos pro Note
  const [linkedTodos, setLinkedTodos] = useState<TodoItem[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.fetchNotes({ query: search || undefined, limit: 200 });
      setNotes(list);
    } finally {
      setLoading(false);
    }
  }, [client, search]);

  useEffect(() => { load(); }, [load]);

  // v672 — verknüpfte Todos laden wenn eine Note ausgewählt ist
  useEffect(() => {
    if (!client || !selected) { setLinkedTodos([]); return; }
    let cancelled = false;
    setLoadingLinks(true);
    client.fetchNoteLinkedTodos(selected.id)
      .then(list => { if (!cancelled) setLinkedTodos(list); })
      .catch(() => { /* nicht-kritisch */ })
      .finally(() => { if (!cancelled) setLoadingLinks(false); });
    return () => { cancelled = true; };
  }, [client, selected]);

  function newNote() {
    setSelected(null);
    setEditTitle('');
    setEditContent('');
    setEditing(true);
  }

  function openEdit(n: NoteItem) {
    setSelected(n);
    setEditTitle(n.title);
    setEditContent(n.content);
    setEditing(true);
  }

  async function save() {
    if (!client || !editTitle.trim() || !editContent.trim()) return;
    if (selected) {
      const updated = await client.updateNote(selected.id, { title: editTitle.trim(), content: editContent });
      if (updated) {
        setNotes(prev => prev.map(n => n.id === selected.id ? updated : n));
        setSelected(updated);
      }
    } else {
      const created = await client.addNote({ title: editTitle.trim(), content: editContent });
      if (created) {
        setNotes(prev => [created, ...prev]);
        setSelected(created);
      }
    }
    setEditing(false);
  }

  async function remove(n: NoteItem) {
    if (!client) return;
    if (!confirm(`Notiz "${n.title}" wirklich löschen?`)) return;
    const ok = await client.deleteNote(n.id);
    if (ok) {
      setNotes(prev => prev.filter(x => x.id !== n.id));
      if (selected?.id === n.id) { setSelected(null); setEditing(false); }
    }
  }

  return (
    <div className="flex h-full">
      {/* Liste */}
      <div className="w-72 border-r border-[#1f1f1f] flex flex-col">
        <div className="p-3 border-b border-[#1f1f1f]">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-base font-semibold text-gray-100">Notes</h1>
            <button
              onClick={newNote}
              className="text-xs px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded"
            >+ Neu</button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Suchen …"
            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {loading && <div className="text-gray-500 text-xs italic p-2">Lade…</div>}
          {!loading && notes.length === 0 && <div className="text-gray-500 text-xs italic p-2">Keine Notizen.</div>}
          {notes.map(n => (
            <button
              key={n.id}
              onClick={() => { setSelected(n); setEditing(false); }}
              className={`w-full text-left p-2 rounded mb-1 border ${
                selected?.id === n.id
                  ? 'bg-blue-500/10 border-blue-500/40'
                  : 'border-transparent hover:bg-[#141414]'
              }`}
            >
              <div className="text-sm text-gray-200 font-medium truncate">{n.title}</div>
              <div className="text-[10px] text-gray-500 mt-0.5">{formatDateTime(n.updatedAt)}</div>
              <div className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">{n.content.slice(0, 100)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected && !editing && (
          <div className="text-gray-500 text-sm text-center mt-12">
            Wähle eine Notiz aus der Liste links oder erstelle eine neue.
          </div>
        )}
        {editing && (
          <div className="max-w-3xl space-y-3">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Titel"
              className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-3 py-2 text-lg text-gray-100 font-medium focus:outline-none focus:border-blue-500"
            />
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Inhalt …"
              rows={20}
              className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500 resize-y"
            />
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={!editTitle.trim() || !editContent.trim()}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-sm font-semibold"
              >Speichern</button>
              <button
                onClick={() => { setEditing(false); if (!selected) { setEditTitle(''); setEditContent(''); } }}
                className="px-3 py-1.5 bg-[#1a1a1a] text-gray-400 rounded border border-[#2a2a2a] text-sm"
              >Abbrechen</button>
            </div>
          </div>
        )}
        {selected && !editing && (
          <div className="max-w-3xl">
            <div className="flex items-start justify-between gap-3 mb-2">
              <h2 className="text-2xl font-bold text-gray-100">{selected.title}</h2>
              <div className="flex gap-1.5">
                <button onClick={() => openEdit(selected)} className="px-2 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/40 rounded text-xs">✎ Edit</button>
                <button onClick={() => remove(selected)} className="px-2 py-1 bg-red-500/10 text-red-400 border border-red-500/40 rounded text-xs">🗑 Löschen</button>
              </div>
            </div>
            <div className="text-[11px] text-gray-500 mb-3">
              Erstellt: {formatDateTime(selected.createdAt)}
              {selected.updatedAt !== selected.createdAt && ` · Aktualisiert: ${formatDateTime(selected.updatedAt)}`}
            </div>
            <div className="text-sm text-gray-300 whitespace-pre-wrap font-mono bg-[#0d0d0d] border border-[#1f1f1f] rounded p-3">
              {selected.content}
            </div>
            {/* v673 — Anhänge */}
            <div className="mt-4">
              <AttachmentSection entityType="note" entityId={selected.id} />
            </div>

            {/* v672 — verknüpfte Todos */}
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
                🔖 Verknüpfte Todos {!loadingLinks && `(${linkedTodos.length})`}
              </div>
              {loadingLinks && <div className="text-[11px] text-gray-500 italic">Lade …</div>}
              {!loadingLinks && linkedTodos.length === 0 && (
                <div className="text-[11px] text-gray-600 italic">
                  Keine Todos verknüpft. Im Todo-Detail kannst du diese Notiz verknüpfen.
                </div>
              )}
              <div className="space-y-1">
                {linkedTodos.map(t => (
                  <a
                    key={t.id}
                    href="/todos"
                    className="block bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1.5 hover:border-blue-500/40"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-3 h-3 rounded border ${t.completed ? 'bg-emerald-500/30 border-emerald-500/60' : 'border-[#3a3a3a]'}`}>{t.completed ? '✓' : ''}</span>
                      <span className={t.completed ? 'line-through text-gray-500' : 'text-gray-200'}>{t.title}</span>
                      <span className="text-[10px] text-gray-600 ml-auto">{t.list}</span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
