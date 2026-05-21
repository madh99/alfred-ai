'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { TodoItem } from '@/lib/alfred-client';

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

function isOverdue(iso?: string, completed?: boolean): boolean {
  if (!iso || completed) return false;
  return new Date(iso).getTime() < Date.now();
}

export function TodosPage() {
  const { client } = useConfig();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterList, setFilterList] = useState('all');
  const [showCompleted, setShowCompleted] = useState(false);

  // Add-Form
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<Priority>('normal');
  const [newDueDate, setNewDueDate] = useState('');
  const [newList, setNewList] = useState('default');
  const [adding, setAdding] = useState(false);

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
        priority: newPriority,
        dueDate: newDueDate || undefined,
        list: newList,
      });
      if (t) {
        setTodos(prev => [t, ...prev]);
        setNewTitle('');
        setNewDueDate('');
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
    if (!confirm(`Todo "${t.title}" wirklich löschen?`)) return;
    const ok = await client.deleteTodo(t.id);
    if (ok) setTodos(prev => prev.filter(x => x.id !== t.id));
  }

  const lists = Array.from(new Set(todos.map(t => t.list))).sort();
  const filtered = todos
    .filter(t => filterList === 'all' || t.list === filterList)
    .sort((a, b) => {
      // Completed nach unten
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      // dann nach Priority
      const ap = PRIO_ORDER.indexOf(a.priority);
      const bp = PRIO_ORDER.indexOf(b.priority);
      if (ap !== bp) return ap - bp;
      // dann due-date (überfällig zuerst)
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
              onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); }}
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
          return (
            <div
              key={t.id}
              className={`flex items-center gap-2 p-2 border rounded ${
                t.completed ? 'bg-[#0d0d0d] border-[#1f1f1f] opacity-60' : 'bg-[#141414] border-[#2a2a2a]'
              }`}
            >
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
              <div className="flex-1 min-w-0">
                <div className={`text-sm ${t.completed ? 'line-through text-gray-500' : 'text-gray-200'}`}>{t.title}</div>
                {t.description && <div className="text-[11px] text-gray-500 mt-0.5">{t.description}</div>}
              </div>
              {t.dueDate && (
                <span className={`text-[10px] ${overdue ? 'text-red-400' : 'text-gray-500'}`} title={`Fällig: ${formatDue(t.dueDate)}`}>
                  {overdue ? '⏰ ' : '📅 '}{formatDue(t.dueDate)}
                </span>
              )}
              <span className="text-[10px] text-gray-600 font-mono">{t.list}</span>
              <button
                onClick={() => remove(t)}
                className="text-gray-500 hover:text-red-400 text-xs"
                title="Löschen"
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
