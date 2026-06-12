'use client';

/**
 * v870 — Ergebnis-Modal des Deep-Verify-Laufs (read-only Codebase-Prüfung).
 *
 * Zeigt die Verdikte pro Sektion mit Code-Beleg; NICHTS wurde automatisch
 * geändert — der User wendet die Ableitungen per Bulk-Aktion an:
 *   implemented     → done (Beleg wird an die Beschreibung gehängt)
 *   partially       → bleibt offen, Beschreibung um "Rest: …" präzisiert
 *   obsolete        → cancelled (Begründung an die Beschreibung)
 *   not-implemented → unverändert (kein Knopf nötig)
 */
import { useState } from 'react';
import clsx from 'clsx';
import type { AlfredClient, ProjectOpenItem } from '@/lib/alfred-client';

export interface DeepVerifyFinding {
  id: string;
  verdict: 'implemented' | 'partially' | 'not-implemented' | 'obsolete';
  confidence: number;
  evidence: string;
  missing?: string;
}

const VERDICT_META: Record<DeepVerifyFinding['verdict'], { label: string; cls: string }> = {
  implemented: { label: '✅ Implementiert (Code-Beleg)', cls: 'text-emerald-300' },
  partially: { label: '🌓 Teilweise implementiert', cls: 'text-amber-300' },
  'not-implemented': { label: '⭕ Nicht implementiert', cls: 'text-gray-300' },
  obsolete: { label: '🗑️ Obsolet', cls: 'text-red-300' },
};

export function DeepVerifyModal({ client, findings, items, onClose, onApplied }: {
  client: AlfredClient;
  findings: DeepVerifyFinding[];
  items: ProjectOpenItem[];
  onClose: () => void;
  /** Nach Anwendung von Ableitungen — Caller lädt das Projekt-Detail neu. */
  onApplied: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  const itemOf = (id: string) => items.find(i => i.id === id);
  const byVerdict = (v: DeepVerifyFinding['verdict']) => findings.filter(f => f.verdict === v);

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function selectAll(ids: string[]) {
    setSelected(prev => { const n = new Set(prev); for (const i of ids) n.add(i); return n; });
  }

  const dateStr = new Date().toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  /** Wendet die zur Auswahl passenden Ableitungen an (nur auf selektierte IDs). */
  async function applySelected() {
    if (selected.size === 0 || busy) return;
    if (!confirm(`Ableitungen für ${selected.size} Item(s) anwenden? (implemented→done, partially→präzisiert, obsolete→verworfen)`)) return;
    setBusy(true);
    let done = 0, refined = 0, cancelled = 0, failed = 0;
    try {
      for (const f of findings) {
        if (!selected.has(f.id)) continue;
        const item = itemOf(f.id);
        const baseDesc = item?.description ? `${item.description}\n\n` : '';
        try {
          if (f.verdict === 'implemented') {
            const ok = await client.patchProjectOpenItem(f.id, {
              status: 'done',
              description: `${baseDesc}[Deep-Verify ${dateStr}: implementiert — ${f.evidence}]`,
            });
            ok ? done++ : failed++;
          } else if (f.verdict === 'partially') {
            const ok = await client.patchProjectOpenItem(f.id, {
              description: `${baseDesc}[Deep-Verify ${dateStr}: teilweise implementiert — ${f.evidence}. Rest: ${f.missing ?? 'siehe Beleg'}]`,
            });
            ok ? refined++ : failed++;
          } else if (f.verdict === 'obsolete') {
            const ok = await client.patchProjectOpenItem(f.id, {
              status: 'cancelled',
              description: `${baseDesc}[Deep-Verify ${dateStr}: obsolet — ${f.evidence}]`,
            });
            ok ? cancelled++ : failed++;
          }
          // not-implemented: bewusst keine Aktion
        } catch { failed++; }
      }
      setAppliedNote(`✓ Angewendet: ${done} erledigt, ${refined} präzisiert, ${cancelled} verworfen${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}`);
      setSelected(new Set());
      onApplied();
    } finally { setBusy(false); }
  }

  const section = (verdict: DeepVerifyFinding['verdict'], actionable: boolean) => {
    const list = byVerdict(verdict);
    if (list.length === 0) return null;
    const meta = VERDICT_META[verdict];
    return (
      <div key={verdict} className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <span className={clsx('text-xs font-semibold', meta.cls)}>{meta.label} ({list.length})</span>
          {actionable && (
            <button onClick={() => selectAll(list.map(f => f.id))} className="text-[10px] text-blue-400 hover:underline">Alle wählen</button>
          )}
        </div>
        {list.map(f => {
          const item = itemOf(f.id);
          return (
            <div key={f.id} className={clsx('flex items-start gap-2 py-1 px-2 -mx-2 rounded text-xs', selected.has(f.id) && 'bg-blue-500/15')}>
              {actionable
                ? <input type="checkbox" className="mt-0.5" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                : <span className="w-3" />}
              <div className="flex-1 min-w-0">
                <div className="text-gray-200 truncate">{item?.title ?? f.id.slice(0, 8)}</div>
                <div className="text-[10px] text-gray-500">
                  {Math.round(f.confidence * 100)}% · {f.evidence}
                  {f.missing && <span className="text-amber-400"> · Rest: {f.missing}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
          <h3 className="text-base font-semibold text-white">🔬 Deep-Verify — Codebase-Prüfung ({findings.length} Verdikte)</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
        </header>
        <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-[#1f1f1f]">
          Read-only geprüft gegen den aktuellen Code — nichts wurde automatisch geändert. Wähle Items und wende die Ableitungen an.
        </div>
        {appliedNote && (
          <div className="px-4 py-2 text-xs text-emerald-300 bg-emerald-500/10 border-b border-emerald-500/20">{appliedNote}</div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {section('implemented', true)}
          {section('partially', true)}
          {section('obsolete', true)}
          {section('not-implemented', false)}
          {findings.length === 0 && <div className="text-xs text-gray-600 italic">Keine Verdikte vorhanden.</div>}
        </div>
        <footer className="px-4 py-3 border-t border-[#1f1f1f] flex items-center gap-2">
          <span className="text-xs text-gray-500">{selected.size} ausgewählt</span>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Schließen</button>
          <button
            onClick={applySelected}
            disabled={busy || selected.size === 0}
            className="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
          >{busy ? '…' : '✓ Ableitungen anwenden'}</button>
        </footer>
      </div>
    </div>
  );
}
