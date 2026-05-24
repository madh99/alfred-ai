'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectOpenItem, ProjectDecision } from '@/lib/alfred-client';

export interface MentionedItem {
  id: string;
  type: 'open_item' | 'decision';
  title: string;
  priority?: string;
  status?: string;
}

interface ItemMentionPickerProps {
  projectId: string;
  /** Bereits ausgewählte Item-IDs (damit nicht doppelt addable) */
  selectedIds: string[];
  onPick: (item: MentionedItem) => void;
  onClose: () => void;
}

/**
 * v730 — Modal-Picker für Open-Items + Decisions eines Projects.
 * User klickt Item → wird via onPick als Chip zum Chat-Input hinzugefügt → Project-Agent
 * bekommt im Goal einen klaren Bezug zum Item.
 */
export function ItemMentionPicker({ projectId, selectedIds, onPick, onClose }: ItemMentionPickerProps) {
  const { client } = useConfig();
  const [tab, setTab] = useState<'open_items' | 'decisions'>('open_items');
  const [openItems, setOpenItems] = useState<ProjectOpenItem[]>([]);
  const [decisions, setDecisions] = useState<ProjectDecision[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client) return;
      try {
        const detail = await client.fetchProject(projectId);
        if (cancelled) return;
        const open = (detail?.openItems ?? []).filter(i => i.status === 'open' || i.status === 'in_progress');
        // Priority sort: high > normal > low
        const prio = (p: string) => p === 'high' ? 0 : p === 'low' ? 2 : 1;
        open.sort((a, b) => prio(a.priority) - prio(b.priority) || a.title.localeCompare(b.title));
        setOpenItems(open);
        setDecisions(detail?.decisions ?? []);
      } catch { /* */ } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [client, projectId]);

  const selectedSet = new Set(selectedIds);
  const filteredOpenItems = filter ? openItems.filter(i => i.title.toLowerCase().includes(filter.toLowerCase())) : openItems;
  const filteredDecisions = filter ? decisions.filter(d => d.title.toLowerCase().includes(filter.toLowerCase())) : decisions;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-blue-500/40 bg-[#0f0f0f] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-blue-300">📋 Item referenzieren</h2>
          <button onClick={onClose} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
        </div>

        <div className="flex gap-2 mb-3 text-xs">
          <button
            onClick={() => setTab('open_items')}
            className={`px-3 py-1 rounded border ${tab === 'open_items' ? 'bg-blue-500/20 border-blue-500/60 text-blue-300' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}
          >
            🟡 Open-Items ({openItems.length})
          </button>
          <button
            onClick={() => setTab('decisions')}
            className={`px-3 py-1 rounded border ${tab === 'decisions' ? 'bg-blue-500/20 border-blue-500/60 text-blue-300' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}
          >
            🎯 Decisions ({decisions.length})
          </button>
        </div>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-xs text-gray-200 mb-3"
          autoFocus
        />

        <div className="flex-1 overflow-auto space-y-1">
          {loading && <div className="text-xs text-gray-500 italic">Lädt…</div>}
          {!loading && tab === 'open_items' && (
            filteredOpenItems.length === 0 ? (
              <div className="text-xs text-gray-500 italic">{filter ? 'Keine Treffer' : 'Keine offenen Items'}</div>
            ) : filteredOpenItems.map(item => {
              const isSelected = selectedSet.has(item.id);
              const prioIcon = item.priority === 'high' ? '🔴' : item.priority === 'low' ? '⚪' : '🟡';
              const statusBadge = item.status === 'in_progress' ? ' (in Arbeit)' : '';
              return (
                <button
                  key={item.id}
                  disabled={isSelected}
                  onClick={() => onPick({ id: item.id, type: 'open_item', title: item.title, priority: item.priority, status: item.status })}
                  className={`w-full text-left text-xs rounded p-2 border ${isSelected ? 'bg-gray-500/10 border-gray-600 text-gray-500 cursor-not-allowed' : 'bg-[#0a0a0a] border-[#1f1f1f] text-gray-200 hover:bg-blue-500/10 hover:border-blue-500/40'}`}
                >
                  <div className="flex items-center gap-2">
                    <span>{prioIcon}</span>
                    <span className="font-mono text-[10px] text-gray-500">{item.id.slice(0, 8)}</span>
                    <span className="flex-1 truncate">{item.title}</span>
                    {isSelected && <span className="text-[10px] text-blue-400">✓ ausgewählt</span>}
                  </div>
                  {item.description && <div className="text-[10px] text-gray-500 mt-1 line-clamp-2">{item.description}{statusBadge}</div>}
                </button>
              );
            })
          )}
          {!loading && tab === 'decisions' && (
            filteredDecisions.length === 0 ? (
              <div className="text-xs text-gray-500 italic">{filter ? 'Keine Treffer' : 'Keine Decisions'}</div>
            ) : filteredDecisions.map(d => {
              const isSelected = selectedSet.has(d.id);
              return (
                <button
                  key={d.id}
                  disabled={isSelected}
                  onClick={() => onPick({ id: d.id, type: 'decision', title: d.title })}
                  className={`w-full text-left text-xs rounded p-2 border ${isSelected ? 'bg-gray-500/10 border-gray-600 text-gray-500 cursor-not-allowed' : 'bg-[#0a0a0a] border-[#1f1f1f] text-gray-200 hover:bg-blue-500/10 hover:border-blue-500/40'}`}
                >
                  <div className="flex items-center gap-2">
                    <span>🎯</span>
                    <span className="font-mono text-[10px] text-gray-500">{d.id.slice(0, 8)}</span>
                    <span className="flex-1 truncate">{d.title}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
