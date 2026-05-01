'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { MemoryEntry } from '@/lib/alfred-client';

const TYPE_ORDER = ['correction', 'preference', 'fact', 'entity', 'general', 'pattern'];
const TYPE_LABELS: Record<string, string> = {
  correction: 'Korrekturen',
  preference: 'Präferenzen',
  fact: 'Fakten',
  entity: 'Entitäten',
  general: 'Allgemein',
  pattern: 'Muster',
};

function statusOf(m: MemoryEntry): { label: string; color: string } {
  const now = new Date().toISOString();
  if (m.expiresAt && m.expiresAt < now) return { label: 'EXPIRED', color: 'bg-red-500/20 text-red-400 border-red-500/40' };
  if (m.relevantUntil && m.relevantUntil < now) return { label: 'ABGELAUFEN', color: 'bg-amber-500/20 text-amber-400 border-amber-500/40' };
  if (m.key.endsWith('_resolved')) return { label: 'RESOLVED', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' };
  if (m.expiresAt) return { label: `läuft ab ${m.expiresAt.slice(0, 10)}`, color: 'bg-blue-500/20 text-blue-400 border-blue-500/40' };
  if (m.relevantUntil) return { label: `gültig bis ${m.relevantUntil.slice(0, 10)}`, color: 'bg-blue-500/20 text-blue-400 border-blue-500/40' };
  return { label: 'AKTIV', color: 'bg-gray-500/20 text-gray-300 border-gray-500/40' };
}

export function MemoriesPage() {
  const { client } = useConfig();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('correction');
  const [search, setSearch] = useState('');
  const [showExpired, setShowExpired] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchMemories(filterType === 'all' ? undefined : filterType);
      setMemories(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, filterType]);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(m: MemoryEntry) {
    if (!client) return;
    if (!confirm(`Memory "${m.key}" wirklich löschen?\n\nWert: ${m.value.slice(0, 200)}`)) return;
    const ok = await client.deleteMemory(m.id);
    if (ok) {
      setMemories(prev => prev.filter(x => x.id !== m.id));
    } else {
      alert('Löschen fehlgeschlagen.');
    }
  }

  const now = new Date().toISOString();
  const visible = memories
    .filter(m => showExpired || !((m.expiresAt && m.expiresAt < now) || (m.relevantUntil && m.relevantUntil < now)))
    .filter(m => !search || m.key.toLowerCase().includes(search.toLowerCase()) || m.value.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Memories</h1>
          <p className="text-sm text-gray-500 mt-1">
            User-Memories — Korrekturen, Präferenzen, Fakten, Entitäten. Manuelles Löschen wenn etwas falsch oder obsolet ist.
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
        <button
          onClick={() => setFilterType('all')}
          className={`px-3 py-1.5 text-xs rounded-lg border ${filterType === 'all' ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
        >
          Alle ({memories.length})
        </button>
        {TYPE_ORDER.map(t => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${filterType === t ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={showExpired} onChange={e => setShowExpired(e.target.checked)} />
          Abgelaufene zeigen
        </label>
      </div>

      <input
        type="text"
        placeholder="Suchen in Key oder Wert..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none mb-4"
      />

      {loading && <div className="text-gray-500 text-sm">Lade...</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {!loading && visible.length === 0 && (
        <div className="text-gray-500 text-sm py-8 text-center">Keine Memories gefunden.</div>
      )}

      <div className="space-y-2">
        {visible.map(m => {
          const status = statusOf(m);
          return (
            <div
              key={m.id}
              className="p-4 bg-[#141414] border border-[#222] rounded-lg hover:border-[#333] transition-colors"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 text-[10px] uppercase font-mono rounded border ${status.color}`}>
                    {status.label}
                  </span>
                  <span className="px-2 py-0.5 text-[10px] uppercase font-mono rounded bg-[#222] text-gray-500 border border-[#2a2a2a]">
                    {m.type}
                  </span>
                  <code className="text-sm text-blue-400 font-mono break-all">{m.key}</code>
                </div>
                <button
                  onClick={() => handleDelete(m)}
                  className="px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded"
                >
                  Löschen
                </button>
              </div>
              <div className="text-sm text-gray-300 whitespace-pre-wrap mb-2 leading-relaxed">{m.value}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 font-mono">
                <span>Erfasst: {m.createdAt?.slice(0, 16).replace('T', ' ')}</span>
                {m.updatedAt !== m.createdAt && <span>Aktualisiert: {m.updatedAt?.slice(0, 16).replace('T', ' ')}</span>}
                <span>Quelle: {m.source}</span>
                <span>Konfidenz: {(m.confidence * 100).toFixed(0)}%</span>
                {m.relevantUntil && <span>Relevant bis: {m.relevantUntil.slice(0, 10)}</span>}
                {m.expiresAt && <span>Läuft ab: {m.expiresAt.slice(0, 10)}</span>}
                {m.sourceEventRefs && m.sourceEventRefs.length > 0 && (
                  <span>Betrifft: {m.sourceEventRefs.slice(0, 3).join(', ')}{m.sourceEventRefs.length > 3 ? `, +${m.sourceEventRefs.length - 3}` : ''}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
