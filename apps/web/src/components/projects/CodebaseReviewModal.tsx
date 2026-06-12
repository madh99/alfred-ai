'use client';

/**
 * v879 — Codebase-Review: Start-Dialog → Live-Output → Ergebnis mit Übernahme.
 *
 * Der gewählte CLI-Agent reviewt das Repo read-only (Default-Scope: Security,
 * Bugs, Lücken, Qualität) mit zweistufiger Selbst-Hinterfragung; optional
 * prüfen 1–2 ANDERE Agents die Befunde adversarial gegen (REFUTE-Auftrag).
 * Es wird NICHTS automatisch geändert — die Übernahme ausgewählter Befunde
 * in Open-Items + Roadmap-Milestones macht der User hier im Modal.
 */
import { useEffect, useState } from 'react';
import type { AlfredClient, CodebaseReviewFinding } from '@/lib/alfred-client';
import { CodeRunLivePanel } from './CodeRunLivePanel';

const SEVERITY_META: Record<CodebaseReviewFinding['severity'], { label: string; cls: string; prio: 'high' | 'normal' | 'low' }> = {
  critical: { label: '🔴 Critical', cls: 'text-red-300', prio: 'high' },
  high: { label: '🟠 High', cls: 'text-orange-300', prio: 'high' },
  medium: { label: '🟡 Medium', cls: 'text-amber-300', prio: 'normal' },
  low: { label: '⚪ Low', cls: 'text-gray-300', prio: 'low' },
};

const KIND_ICON: Record<CodebaseReviewFinding['kind'], string> = {
  security: '🛡', bug: '🐛', gap: '🕳', quality: '🧹',
};

const DEFAULT_SCOPE = 'Security, Bugs, Lücken, Qualität';

export function CodebaseReviewModal({ client, projectId, onClose, onApplied, notify }: {
  client: AlfredClient;
  projectId: string;
  onClose: () => void;
  /** Nach Übernahme von Befunden — Caller lädt das Projekt-Detail neu. */
  onApplied: () => void;
  notify: (kind: 'success' | 'error' | 'info', text: string) => void;
}) {
  const [phase, setPhase] = useState<'setup' | 'running' | 'result'>('setup');
  const [agents, setAgents] = useState<string[]>([]);
  const [scope, setScope] = useState('');
  const [reviewAgent, setReviewAgent] = useState<string>('');
  const [crossChecks, setCrossChecks] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [findings, setFindings] = useState<CodebaseReviewFinding[] | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    void (async () => {
      const a = await client.fetchCodeAgents();
      setAgents(a);
      if (a.length > 0) setReviewAgent(a[0]);
    })();
  }, [client]);

  async function start() {
    if (starting) return;
    setStarting(true);
    try {
      const r = await client.projectReviewCodebase(projectId, {
        scope: scope.trim() || undefined,
        reviewAgent: reviewAgent || undefined,
        crossCheckAgents: [...crossChecks],
      });
      if (r.ok && r.liveTaskId) {
        setTaskId(r.liveTaskId);
        setPhase('running');
      } else {
        notify('error', `Review-Start fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
      }
    } finally {
      setStarting(false);
    }
  }

  async function loadResult() {
    if (!taskId) return;
    const r = await client.projectReviewResult(taskId);
    if (r.status === 'done') {
      setFindings(r.findings ?? []);
      // Vorauswahl: alles außer von Gegenprüfern WIDERLEGTEM
      setSelected(new Set((r.findings ?? [])
        .filter(f => !(f.crossChecks ?? []).some(c => c.verdict === 'refuted'))
        .map(f => f.id)));
      setPhase('result');
    } else if (r.status === 'failed') {
      setResultError(r.error ?? 'Review fehlgeschlagen');
      setPhase('result');
    }
    // running/unknown: Panel läuft weiter, onEnded ruft erneut
  }

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  /** Übernahme: pro Befund Open-Item (Severity→Priorität) + Roadmap-Milestone. */
  async function applySelected() {
    if (!findings || selected.size === 0 || applying) return;
    setApplying(true);
    let created = 0, failed = 0;
    try {
      // Reihenfolge je Milestone für roadmap_order
      const orderByMilestone = new Map<string, number>();
      for (const f of findings) {
        if (!selected.has(f.id)) continue;
        const meta = SEVERITY_META[f.severity];
        const crossNote = (f.crossChecks ?? []).map(c => `${c.agent}: ${c.verdict}${c.note ? ` (${c.note})` : ''}`).join(' · ');
        try {
          const item = await client.addProjectOpenItem(projectId, {
            title: f.title.slice(0, 200),
            description: `${KIND_ICON[f.kind]} ${f.kind} · ${f.severity} · Beleg: ${f.evidence}${crossNote ? `\nGegenprüfung: ${crossNote}` : ''}\n[Quelle: Codebase-Review]`.slice(0, 1500),
            priority: meta.prio,
          });
          if (item) {
            const milestone = f.suggestedMilestone || `Review: ${f.kind}`;
            const order = (orderByMilestone.get(milestone) ?? 0) + 1;
            orderByMilestone.set(milestone, order);
            await client.updateOpenItemRoadmap(item.id, { milestone, order });
            created++;
          } else failed++;
        } catch { failed++; }
      }
      notify(failed === 0 ? 'success' : 'error',
        `${created} Befund(e) als Open-Items mit Roadmap-Milestone übernommen${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}.`);
      onApplied();
      onClose();
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
          <h3 className="text-base font-semibold text-white">🔍 Codebase-Review</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
        </header>

        {phase === 'setup' && (
          <div className="p-4 space-y-3 text-xs">
            <div>
              <div className="text-gray-400 mb-1">Scope (leer = Standard: {DEFAULT_SCOPE})</div>
              <textarea
                value={scope}
                onChange={e => setScope(e.target.value)}
                placeholder={DEFAULT_SCOPE}
                rows={2}
                className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 resize-y"
              />
            </div>
            <div>
              <div className="text-gray-400 mb-1">Review-Agent</div>
              <select value={reviewAgent} onChange={e => setReviewAgent(e.target.value)} className="px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200">
                {agents.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <div className="text-gray-400 mb-1">Gegenprüfung (optional, adversarial — andere Agents versuchen die Befunde zu widerlegen)</div>
              <div className="flex flex-wrap gap-3">
                {agents.filter(a => a !== reviewAgent).map(a => (
                  <label key={a} className="flex items-center gap-1.5 text-gray-300">
                    <input
                      type="checkbox"
                      checked={crossChecks.has(a)}
                      onChange={() => setCrossChecks(prev => { const n = new Set(prev); if (n.has(a)) n.delete(a); else n.add(a); return n; })}
                    />
                    {a}
                  </label>
                ))}
                {agents.length <= 1 && <span className="text-gray-600 italic">Keine weiteren Agents konfiguriert.</span>}
              </div>
            </div>
            <div className="text-[10px] text-gray-600">
              Read-only (einzige Schreiboperation: Review-Doc in docs/). Dauert einige Minuten und nutzt die CLI-Subscription{crossChecks.size > 0 ? ` — Gegenprüfung = +${crossChecks.size} Lauf/Läufe` : ''}. Es wird NICHTS automatisch geändert.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1 text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Abbrechen</button>
              <button onClick={() => void start()} disabled={starting || agents.length === 0} className="px-3 py-1 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded">
                {starting ? '⏳ Starte…' : '🔍 Review starten'}
              </button>
            </div>
          </div>
        )}

        {phase === 'running' && taskId && (
          <div className="p-4 overflow-y-auto">
            <CodeRunLivePanel
              client={client}
              taskId={taskId}
              onEnded={() => { void loadResult(); }}
              onClose={() => { /* Panel bleibt bis Ergebnis */ }}
            />
            <div className="text-[10px] text-gray-600 mt-2">Review läuft — das Ergebnis erscheint hier automatisch. Du kannst das Modal schließen; das Ergebnis bleibt 30 min abrufbar.</div>
          </div>
        )}

        {phase === 'result' && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {resultError && <div className="text-xs text-red-400">✗ {resultError}</div>}
              {findings !== null && findings.length === 0 && !resultError && (
                <div className="text-xs text-emerald-400">✓ Keine Befunde — der Review hat nichts Belegbares gefunden. Details im Review-Doc (Doku-Tab).</div>
              )}
              {findings !== null && findings.length > 0 && (
                <div className="space-y-1">
                  {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
                    const list = findings.filter(f => f.severity === sev);
                    if (list.length === 0) return null;
                    return (
                      <div key={sev} className="mb-2">
                        <div className={`text-xs font-semibold mb-1 ${SEVERITY_META[sev].cls}`}>{SEVERITY_META[sev].label} ({list.length})</div>
                        {list.map(f => {
                          const refuted = (f.crossChecks ?? []).some(c => c.verdict === 'refuted');
                          return (
                            <div key={f.id} className={`flex items-start gap-2 py-1 px-2 -mx-2 rounded text-xs ${selected.has(f.id) ? 'bg-blue-500/15' : ''}`}>
                              <input type="checkbox" className="mt-0.5" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                              <div className="flex-1 min-w-0">
                                <div className={`${refuted ? 'text-gray-500 line-through' : 'text-gray-200'}`}>{KIND_ICON[f.kind]} {f.title}</div>
                                <div className="text-[10px] text-gray-500">{Math.round(f.confidence * 100)}% · {f.evidence}</div>
                                {(f.crossChecks ?? []).map(c => (
                                  <div key={c.agent} className={`text-[10px] ${c.verdict === 'confirmed' ? 'text-emerald-400' : c.verdict === 'refuted' ? 'text-red-400' : 'text-amber-400'}`}>
                                    🧪 {c.agent}: {c.verdict}{c.note ? ` — ${c.note}` : ''}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <footer className="px-4 py-3 border-t border-[#1f1f1f] flex items-center gap-2">
              <span className="text-xs text-gray-500">{selected.size} ausgewählt</span>
              <div className="flex-1" />
              <button onClick={onClose} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Schließen</button>
              <button
                onClick={() => void applySelected()}
                disabled={applying || selected.size === 0}
                className="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
                title="Legt pro Befund ein Open-Item an (Severity → Priorität) und ordnet es einem Roadmap-Milestone zu"
              >{applying ? '…' : '✓ Als Items + Roadmap übernehmen'}</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
