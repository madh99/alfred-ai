'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { TodoItem, TodoNote } from '@/lib/alfred-client';

type Priority = 'low' | 'normal' | 'high' | 'urgent';

const PRIO_ORDER: Priority[] = ['urgent', 'high', 'normal', 'low'];
const PRIO_BADGE: Record<Priority, string> = {
  urgent: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  normal: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  low: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
};

function formatDue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function isOverdue(iso?: string, completed?: boolean): boolean {
  if (!iso || completed) return false;
  return new Date(iso).getTime() < Date.now();
}

interface EditState {
  title: string;
  description: string;
  priority: Priority;
  dueDate: string; // yyyy-mm-dd (oder leer)
  list: string;
}

function toEditState(t: TodoItem): EditState {
  return {
    title: t.title,
    description: t.description ?? '',
    priority: t.priority,
    // ISO -> date-only für <input type=date>
    dueDate: t.dueDate ? t.dueDate.slice(0, 10) : '',
    list: t.list,
  };
}

export function TodosPage() {
  const { client } = useConfig();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterList, setFilterList] = useState('all');
  const [showCompleted, setShowCompleted] = useState(false);

  // Add-Form
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<Priority>('normal');
  const [newDueDate, setNewDueDate] = useState('');
  const [newList, setNewList] = useState('default');
  const [adding, setAdding] = useState(false);
  const [showAddDetails, setShowAddDetails] = useState(false);

  // Expandable Detail / Edit / Notes
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [notesByTodo, setNotesByTodo] = useState<Record<string, TodoNote[]>>({});
  const [loadingNotes, setLoadingNotes] = useState<Record<string, boolean>>({});
  const [newNoteContent, setNewNoteContent] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.fetchTodos({ includeCompleted: showCompleted });
      setTodos(list);
    } finally {
      setLoading(false);
    }
  }, [client, showCompleted]);

  useEffect(() => { load(); }, [load]);

  async function addTodo() {
    if (!client || !newTitle.trim() || adding) return;
    setAdding(true);
    try {
      const t = await client.addTodo({
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        priority: newPriority,
        dueDate: newDueDate || undefined,
        list: newList,
      });
      if (t) {
        setTodos(prev => [t, ...prev]);
        setNewTitle('');
        setNewDescription('');
        setNewDueDate('');
        // Priority & List behalten — User legt oft mehrere in derselben Liste an
      }
    } finally {
      setAdding(false);
    }
  }

  async function toggle(t: TodoItem) {
    if (!client) return;
    const updated = await client.toggleTodoComplete(t.id, !t.completed);
    if (updated) {
      setTodos(prev => prev.map(x => x.id === t.id ? updated : x));
    }
  }

  async function remove(t: TodoItem) {
    if (!client) return;
    if (!confirm(`Todo "${t.title}" wirklich löschen?\n\nAlle Arbeitsnotizen dazu werden mitgelöscht.`)) return;
    const ok = await client.deleteTodo(t.id);
    if (ok) {
      setTodos(prev => prev.filter(x => x.id !== t.id));
      if (expandedId === t.id) setExpandedId(null);
    }
  }

  function toggleExpanded(t: TodoItem) {
    if (expandedId === t.id) {
      setExpandedId(null);
      setEditState(null);
      return;
    }
    setExpandedId(t.id);
    setEditState(null);
    // Notes lazy laden
    if (!notesByTodo[t.id]) loadNotes(t.id);
  }

  async function loadNotes(todoId: string) {
    if (!client) return;
    setLoadingNotes(prev => ({ ...prev, [todoId]: true }));
    try {
      const list = await client.fetchTodoNotes(todoId);
      setNotesByTodo(prev => ({ ...prev, [todoId]: list }));
    } finally {
      setLoadingNotes(prev => ({ ...prev, [todoId]: false }));
    }
  }

  function startEdit(t: TodoItem) {
    setEditState(toEditState(t));
  }

  async function saveEdit(t: TodoItem) {
    if (!client || !editState) return;
    setSavingEdit(true);
    try {
      const updated = await client.updateTodo(t.id, {
        title: editState.title.trim(),
        description: editState.description.trim() === '' ? null : editState.description.trim(),
        priority: editState.priority,
        dueDate: editState.dueDate === '' ? null : editState.dueDate,
        list: editState.list.trim() || 'default',
      });
      if (updated) {
        setTodos(prev => prev.map(x => x.id === t.id ? updated : x));
        setEditState(null);
      }
    } finally {
      setSavingEdit(false);
    }
  }

  async function addNote(todoId: string) {
    if (!client || !newNoteContent.trim() || addingNote) return;
    setAddingNote(true);
    try {
      const note = await client.addTodoNote(todoId, newNoteContent.trim());
      if (note) {
        setNotesByTodo(prev => ({
          ...prev,
          [todoId]: [note, ...(prev[todoId] ?? [])],
        }));
        setNewNoteContent('');
      }
    } finally {
      setAddingNote(false);
    }
  }

  async function removeNote(todoId: string, noteId: string) {
    if (!client) return;
    if (!confirm('Diese Notiz wirklich löschen?')) return;
    const ok = await client.deleteTodoNote(noteId);
    if (ok) {
      setNotesByTodo(prev => ({
        ...prev,
        [todoId]: (prev[todoId] ?? []).filter(n => n.id !== noteId),
      }));
    }
  }

  const lists = Array.from(new Set(todos.map(t => t.list))).sort();
  const filtered = todos
    .filter(t => filterList === 'all' || t.list === filterList)
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const ap = PRIO_ORDER.indexOf(a.priority);
      const bp = PRIO_ORDER.indexOf(b.priority);
      if (ap !== bp) return ap - bp;
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return aDue - bDue;
    });

  return (
    <div className="p-6 max-w-4xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Todos</h1>
          <p className="text-sm text-gray-500">{todos.filter(t => !t.completed).length} offen{showCompleted ? ` · ${todos.filter(t => t.completed).length} erledigt` : ''}</p>
        </div>
        <button onClick={load} className="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/40 rounded text-sm hover:bg-blue-500/20">Neu laden</button>
      </div>

      {/* Add-Form */}
      <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-3 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-end">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Titel</label>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !showAddDetails) addTodo(); }}
              placeholder="Neues Todo …"
              className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Priorität</label>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as Priority)}
              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
            >
              <option value="urgent">🔴 Urgent</option>
              <option value="high">🟠 High</option>
              <option value="normal">🔵 Normal</option>
              <option value="low">⚪ Low</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Fällig</label>
            <input
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Liste</label>
            <input
              value={newList}
              onChange={(e) => setNewList(e.target.value)}
              placeholder="default"
              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 w-24"
            />
          </div>
          <button
            onClick={addTodo}
            disabled={!newTitle.trim() || adding}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-sm font-semibold"
          >{adding ? '…' : '+ Add'}</button>
        </div>

        {/* v670 — Optional: Beschreibung beim Anlegen */}
        <div className="mt-2">
          <button
            onClick={() => setShowAddDetails(s => !s)}
            className="text-[11px] text-gray-500 hover:text-blue-400"
          >{showAddDetails ? '▾ Beschreibung ausblenden' : '▸ Mit Beschreibung anlegen'}</button>
          {showAddDetails && (
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Optionale Beschreibung (Kontext, Akzeptanzkriterien, Links …)"
              rows={3}
              className="mt-1 w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 resize-y"
            />
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <select
          value={filterList}
          onChange={(e) => setFilterList(e.target.value)}
          className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200"
        >
          <option value="all">Alle Listen</option>
          {lists.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Erledigte zeigen
        </label>
      </div>

      {loading && <div className="text-gray-500 text-sm italic">Lade…</div>}
      {!loading && filtered.length === 0 && (
        <div className="text-gray-500 text-sm border border-dashed border-[#2a2a2a] rounded p-8 text-center">
          Keine Todos {filterList !== 'all' && `in Liste "${filterList}"`}.
        </div>
      )}

      <div className="space-y-1.5">
        {filtered.map(t => {
          const overdue = isOverdue(t.dueDate, t.completed);
          const isExpanded = expandedId === t.id;
          const isEditing = isExpanded && editState !== null;
          const notes = notesByTodo[t.id] ?? [];
          const notesLoading = !!loadingNotes[t.id];
          return (
            <div
              key={t.id}
              className={`border rounded ${
                t.completed ? 'bg-[#0d0d0d] border-[#1f1f1f] opacity-60' : 'bg-[#141414] border-[#2a2a2a]'
              }`}
            >
              {/* Row */}
              <div className="flex items-center gap-2 p-2">
                <button
                  onClick={() => toggle(t)}
                  className={`w-5 h-5 rounded border flex items-center justify-center text-xs ${
                    t.completed
                      ? 'bg-emerald-500/30 border-emerald-500/60 text-emerald-300'
                      : 'border-[#3a3a3a] hover:border-emerald-500/60'
                  }`}
                  title={t.completed ? 'Wieder offen' : 'Erledigen'}
                >{t.completed ? '✓' : ''}</button>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${PRIO_BADGE[t.priority]}`}>{t.priority}</span>
                <button
                  onClick={() => toggleExpanded(t)}
                  className="flex-1 min-w-0 text-left"
                  title={isExpanded ? 'Details einklappen' : 'Details / Bearbeiten / Notizen'}
                >
                  <div className={`text-sm ${t.completed ? 'line-through text-gray-500' : 'text-gray-200'} flex items-center gap-1`}>
                    <span className="text-gray-600">{isExpanded ? '▾' : '▸'}</span>
                    <span className="truncate">{t.title}</span>
                  </div>
                  {t.description && !isExpanded && (
                    <div className="text-[11px] text-gray-500 mt-0.5 truncate ml-3">{t.description}</div>
                  )}
                </button>
                {t.dueDate && (
                  <span className={`text-[10px] ${overdue ? 'text-red-400' : 'text-gray-500'}`} title={`Fällig: ${formatDue(t.dueDate)}`}>
                    {overdue ? '⏰ ' : '📅 '}{formatDue(t.dueDate)}
                  </span>
                )}
                <span className="text-[10px] text-gray-600 font-mono">{t.list}</span>
                {notes.length > 0 && (
                  <span className="text-[10px] text-amber-400" title={`${notes.length} Notizen`}>📝 {notes.length}</span>
                )}
                <button
                  onClick={() => remove(t)}
                  className="text-gray-500 hover:text-red-400 text-xs"
                  title="Löschen"
                >✕</button>
              </div>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="border-t border-[#2a2a2a] p-3 space-y-3 bg-[#0f0f0f]">
                  {/* Edit-Form ODER Anzeige */}
                  {!isEditing && (
                    <div className="space-y-2">
                      {t.description ? (
                        <div className="text-xs text-gray-300 whitespace-pre-wrap">{t.description}</div>
                      ) : (
                        <div className="text-xs text-gray-600 italic">Keine Beschreibung.</div>
                      )}
                      <div className="flex items-center gap-3 text-[10px] text-gray-500">
                        <span>Angelegt: {formatDateTime(t.createdAt)}</span>
                        {t.updatedAt !== t.createdAt && <span>· Zuletzt: {formatDateTime(t.updatedAt)}</span>}
                      </div>
                      <button
                        onClick={() => startEdit(t)}
                        className="px-2 py-1 bg-blue-500/10 border border-blue-500/40 text-blue-300 rounded text-xs hover:bg-blue-500/20"
                      >✏ Bearbeiten</button>
                    </div>
                  )}
                  {isEditing && editState && (
                    <div className="space-y-2 bg-[#0a0a0a] border border-blue-500/30 rounded p-2">
                      <div className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold">✏ Bearbeiten</div>
                      <input
                        value={editState.title}
                        onChange={(e) => setEditState({ ...editState, title: e.target.value })}
                        placeholder="Titel"
                        className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
                      />
                      <textarea
                        value={editState.description}
                        onChange={(e) => setEditState({ ...editState, description: e.target.value })}
                        placeholder="Beschreibung (optional)"
                        rows={4}
                        className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 resize-y"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Priorität</label>
                          <select
                            value={editState.priority}
                            onChange={(e) => setEditState({ ...editState, priority: e.target.value as Priority })}
                            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
                          >
                            <option value="urgent">🔴 Urgent</option>
                            <option value="high">🟠 High</option>
                            <option value="normal">🔵 Normal</option>
                            <option value="low">⚪ Low</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Fällig</label>
                          <input
                            type="date"
                            value={editState.dueDate}
                            onChange={(e) => setEditState({ ...editState, dueDate: e.target.value })}
                            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Liste</label>
                          <input
                            value={editState.list}
                            onChange={(e) => setEditState({ ...editState, list: e.target.value })}
                            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditState(null)} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200">Abbrechen</button>
                        <button
                          onClick={() => saveEdit(t)}
                          disabled={savingEdit || !editState.title.trim()}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs font-semibold"
                        >{savingEdit ? '…' : 'Speichern'}</button>
                      </div>
                    </div>
                  )}

                  {/* Notes-Section */}
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold flex items-center justify-between">
                      <span>📝 Arbeitsnotizen / Fortschritte ({notes.length})</span>
                      {!notesLoading && <button onClick={() => loadNotes(t.id)} className="text-gray-500 hover:text-blue-400 text-[10px]">↻</button>}
                    </div>

                    {/* Add-Note-Input */}
                    <div className="flex gap-1.5">
                      <textarea
                        value={expandedId === t.id ? newNoteContent : ''}
                        onChange={(e) => setNewNoteContent(e.target.value)}
                        placeholder="Notiz / Fortschritt festhalten … (Cmd/Ctrl+Enter zum Speichern)"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            addNote(t.id);
                          }
                        }}
                        rows={2}
                        className="flex-1 bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 resize-y"
                      />
                      <button
                        onClick={() => addNote(t.id)}
                        disabled={!newNoteContent.trim() || addingNote}
                        className="px-2 py-1 bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 rounded text-xs hover:bg-emerald-600/40 disabled:opacity-40"
                      >{addingNote ? '…' : '+ Notiz'}</button>
                    </div>

                    {/* Notes-Liste */}
                    {notesLoading && <div className="text-[11px] text-gray-500 italic">Lade Notizen…</div>}
                    {!notesLoading && notes.length === 0 && (
                      <div className="text-[11px] text-gray-600 italic border border-dashed border-[#222] rounded p-2 text-center">
                        Noch keine Arbeitsnotizen. Halte hier Fortschritte, Blocker, Entscheidungen oder Zwischenergebnisse fest.
                      </div>
                    )}
                    <div className="space-y-1">
                      {notes.map(n => (
                        <div key={n.id} className="bg-[#0a0a0a] border border-[#222] rounded px-2 py-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-xs text-gray-200 whitespace-pre-wrap flex-1 min-w-0">{n.content}</div>
                            <button
                              onClick={() => removeNote(t.id, n.id)}
                              className="text-gray-600 hover:text-red-400 text-[10px] shrink-0"
                              title="Notiz löschen"
                            >✕</button>
                          </div>
                          <div className="text-[10px] text-gray-600 mt-0.5">{formatDateTime(n.createdAt)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
