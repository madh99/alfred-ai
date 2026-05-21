'use client';

import { useState } from 'react';
import clsx from 'clsx';

interface AuditStats {
  total: number;
  byPriority: { high: number; normal: number; low: number };
  byAge: { d1: number; d1_7: number; d7_30: number; d30_plus: number };
  withDescription: number;
  autoMarked: number;
}
interface AuditItem { id: string; title: string; priority?: string; createdAt?: string; description?: string; ageDays?: number; confidence?: number }
interface LlmFinding { item_id: string; verdict: 'likely-done' | 'outdated' | 'redundant' | 'still-open'; confidence: number; reason: string }
interface AuditData {
  stats: AuditStats;
  allItems: AuditItem[];
  llmLikelyDone: LlmFinding[];
  llmOutdated: LlmFinding[];
  llmRedundant: LlmFinding[];
  possiblyDone: AuditItem[];
  stale30: AuditItem[];
  duplicateGroups: Array<Array<{ id: string; title: string }>>;
}

interface Props {
  data: AuditData;
  onClose: () => void;
  onBulkClose: (ids: string[]) => Promise<void>;
  onBulkWork: (ids: string[]) => Promise<void>;
}

const VERDICT_COLOR: Record<string, string> = {
  'likely-done': 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300',
  'outdated': 'border-zinc-500/40 bg-zinc-500/5 text-zinc-300',
  'redundant': 'border-amber-500/40 bg-amber-500/5 text-amber-300',
  'still-open': 'border-blue-500/40 bg-blue-500/5 text-blue-300',
};

export function AuditModal({ data, onClose, onBulkClose, onBulkWork }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'close' | 'work' | null>(null);

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function selectAll(ids: string[]) {
    setSelected(prev => { const n = new Set(prev); for (const i of ids) n.add(i); return n; });
  }
  function clearSelection() { setSelected(new Set()); }

  async function doBulkClose() {
    if (selected.size === 0) return;
    if (!confirm(`${selected.size} Items als erledigt markieren?`)) return;
    setBusy('close');
    try { await onBulkClose([...selected]); setSelected(new Set()); }
    finally { setBusy(null); }
  }
  async function doBulkWork() {
    if (selected.size === 0) return;
    if (!confirm(`Project-Agent mit ${selected.size} Items als Goal starten?`)) return;
    setBusy('work');
    try { await onBulkWork([...selected]); }
    finally { setBusy(null); }
  }

  const titleOf = (id: string) => data.allItems.find(i => i.id === id)?.title ?? id.slice(0, 8);
  const itemRow = (id: string, badge?: React.ReactNode) => (
    <div key={id} className={clsx('flex items-center gap-2 py-1 px-2 -mx-2 rounded text-sm', selected.has(id) && 'bg-blue-500/15')}>
      <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
      <span className="font-mono text-[10px] text-gray-500">{id.slice(0, 8)}</span>
      <span className="text-gray-200 flex-1 truncate">{titleOf(id)}</span>
      {badge}
    </div>
  );

  const s = data.stats;
  const dataIsEmpty = data.llmLikelyDone.length === 0 && data.llmOutdated.length === 0 &&
    data.llmRedundant.length === 0 && data.possiblyDone.length === 0 &&
    data.stale30.length === 0 && data.duplicateGroups.length === 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
          <h3 className="text-lg font-semibold text-white">🔍 Open-Items-Audit</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
        </header>

        {/* Stats Header */}
        <div className="px-4 py-3 border-b border-[#1f1f1f] grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="bg-[#161616] border border-[#222] rounded px-3 py-2">
            <div className="text-gray-500 uppercase tracking-wide">Total</div>
            <div className="text-gray-100 text-xl font-mono">{s.total}</div>
          </div>
          <div className="bg-[#161616] border border-[#222] rounded px-3 py-2">
            <div className="text-gray-500 uppercase tracking-wide">Priorität</div>
            <div className="text-gray-200 mt-1 flex gap-2">
              <span className="text-red-400">🔴 {s.byPriority.high}</span>
              <span className="text-amber-400">🟡 {s.byPriority.normal}</span>
              <span className="text-gray-400">⚪ {s.byPriority.low}</span>
            </div>
          </div>
          <div className="bg-[#161616] border border-[#222] rounded px-3 py-2">
            <div className="text-gray-500 uppercase tracking-wide">Alter</div>
            <div className="text-gray-300 mt-1 text-[11px] leading-tight">
              <div>&lt;1d: <span className="font-mono">{s.byAge.d1}</span> · 1-7d: <span className="font-mono">{s.byAge.d1_7}</span></div>
              <div>7-30d: <span className="font-mono">{s.byAge.d7_30}</span> · ≥30d: <span className="font-mono">{s.byAge.d30_plus}</span></div>
            </div>
          </div>
          <div className="bg-[#161616] border border-[#222] rounded px-3 py-2">
            <div className="text-gray-500 uppercase tracking-wide">Qualität</div>
            <div className="text-gray-300 mt-1 text-[11px] leading-tight">
              <div>Mit Beschreibung: <span className="font-mono">{s.withDescription}/{s.total}</span></div>
              <div>Auto-markiert: <span className="font-mono">{s.autoMarked}</span></div>
            </div>
          </div>
        </div>

        {/* Bulk Action Bar (sticky) */}
        {selected.size > 0 && (
          <div className="px-4 py-2 border-b border-[#1f1f1f] bg-blue-500/10 flex items-center gap-2">
            <span className="text-xs text-blue-200">{selected.size} ausgewählt</span>
            <div className="flex-1" />
            <button onClick={clearSelection} className="text-[10px] text-gray-400 hover:text-gray-200">Löschen</button>
            <button
              onClick={doBulkClose}
              disabled={busy !== null}
              className="px-2 py-1 text-[11px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
            >{busy === 'close' ? '…' : '✓ Als erledigt markieren'}</button>
            <button
              onClick={doBulkWork}
              disabled={busy !== null}
              className="px-2 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
            >{busy === 'work' ? '…' : '▶ Mit Project-Agent abarbeiten'}</button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {dataIsEmpty && (
            <div className="text-center text-gray-500 text-sm py-8">
              ✓ Keine Auffälligkeiten gefunden.<br />
              <span className="text-[11px] text-gray-600">Mit {s.total} aktiven Items — alle sehen relevant aus.</span>
            </div>
          )}

          {data.llmLikelyDone.length > 0 && (
            <Section
              title={`🤖 LLM: wahrscheinlich schon erledigt (${data.llmLikelyDone.length})`}
              subtitle="LLM hat im Repo Indizien gefunden dass diese Items bereits umgesetzt wurden."
              onSelectAll={() => selectAll(data.llmLikelyDone.map(f => f.item_id))}
            >
              {data.llmLikelyDone.map(f => itemRow(
                f.item_id,
                <span className="text-[10px] text-emerald-300 shrink-0" title={f.reason}>{Math.round(f.confidence * 100)}% · {f.reason.slice(0, 60)}</span>,
              ))}
            </Section>
          )}

          {data.llmOutdated.length > 0 && (
            <Section
              title={`🗑️ LLM: veraltet (${data.llmOutdated.length})`}
              subtitle="Items die laut LLM nicht mehr relevant sind."
              onSelectAll={() => selectAll(data.llmOutdated.map(f => f.item_id))}
            >
              {data.llmOutdated.map(f => itemRow(
                f.item_id,
                <span className="text-[10px] text-zinc-400 shrink-0" title={f.reason}>{f.reason.slice(0, 80)}</span>,
              ))}
            </Section>
          )}

          {data.llmRedundant.length > 0 && (
            <Section
              title={`🔁 LLM: redundant (${data.llmRedundant.length})`}
              subtitle="Items die mit anderen Items überlappen."
              onSelectAll={() => selectAll(data.llmRedundant.map(f => f.item_id))}
            >
              {data.llmRedundant.map(f => itemRow(
                f.item_id,
                <span className="text-[10px] text-amber-400 shrink-0" title={f.reason}>{f.reason.slice(0, 80)}</span>,
              ))}
            </Section>
          )}

          {data.possiblyDone.length > 0 && (
            <Section
              title={`🤖 Matcher: vermutlich erledigt (${data.possiblyDone.length})`}
              subtitle="OpenItemMatcher hatte Indizien, aber Confidence zu niedrig für Auto-Done."
              onSelectAll={() => selectAll(data.possiblyDone.map(i => i.id))}
            >
              {data.possiblyDone.map(i => itemRow(
                i.id,
                <span className="text-[10px] text-amber-400 shrink-0">{Math.round((i.confidence ?? 0) * 100)}%</span>,
              ))}
            </Section>
          )}

          {data.stale30.length > 0 && (
            <Section
              title={`🕸️ ≥30 Tage offen (${data.stale30.length})`}
              subtitle="Items die seit über einem Monat im Backlog liegen."
              onSelectAll={() => selectAll(data.stale30.map(i => i.id))}
            >
              {data.stale30.map(i => itemRow(
                i.id,
                <span className="text-[10px] text-gray-500 shrink-0">{i.ageDays}d</span>,
              ))}
            </Section>
          )}

          {data.duplicateGroups.length > 0 && (
            <Section
              title={`👯 Title-Duplikate (${data.duplicateGroups.length} Gruppen)`}
              subtitle="Items mit fast identischen Titeln — meist behält man eines."
              onSelectAll={() => selectAll(data.duplicateGroups.flatMap(g => g.slice(1).map(i => i.id)))}
            >
              {data.duplicateGroups.map((group, gi) => (
                <div key={gi} className="border-l-2 border-amber-500/30 pl-2 my-1">
                  <div className="text-[10px] text-amber-400/70 uppercase mb-1">Gruppe {gi + 1} ({group.length})</div>
                  {group.map(i => itemRow(i.id))}
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children, onSelectAll }: { title: string; subtitle?: string; children: React.ReactNode; onSelectAll: () => void }) {
  return (
    <div className="border border-[#1f1f1f] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#161616]">
        <div>
          <h4 className="text-sm font-semibold text-gray-200">{title}</h4>
          {subtitle && <p className="text-[11px] text-gray-500">{subtitle}</p>}
        </div>
        <button onClick={onSelectAll} className="text-[11px] text-blue-400 hover:text-blue-300">+ Alle auswählen</button>
      </div>
      <div className="px-2 py-1.5">{children}</div>
    </div>
  );
}
