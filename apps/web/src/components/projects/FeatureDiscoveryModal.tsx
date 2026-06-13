'use client';

/**
 * v880 — Feature-Discovery: Setup → Live-Output → Vorschläge mit Entscheidung.
 *
 * 1–2 CLI-Agents analysieren das Repo read-only und schlagen nützliche neue
 * Features vor (Bestand + abgelehnte Vorschläge werden ausgeklammert — die
 * Features-Library ist das Gedächtnis). Pro Vorschlag: ✅ Annehmen startet die
 * Plan-Ausarbeitung (Arbeitspakete → Items + Roadmap-Milestone, ⛓-verkettet),
 * ❌ Ablehnen merkt sich der Vorschlag dauerhaft als rejected.
 */
import { useEffect, useState } from 'react';
import type { AlfredClient, FeatureSuggestionItem } from '@/lib/alfred-client';
import { CodeRunLivePanel } from './CodeRunLivePanel';

const EFFORT_META: Record<'S' | 'M' | 'L', { label: string; cls: string }> = {
  S: { label: 'S — klein', cls: 'text-emerald-300' },
  M: { label: 'M — mittel', cls: 'text-amber-300' },
  L: { label: 'L — groß', cls: 'text-red-300' },
};

type Decision = 'accepted' | 'rejected' | 'planning';

export function FeatureDiscoveryModal({ client, projectId, preferredAgent, onClose, onApplied, notify }: {
  client: AlfredClient;
  projectId: string;
  /** v889b — Default-Vorauswahl aus der Projekt-CLI-Strategie (statt agents[0]). */
  preferredAgent?: string;
  onClose: () => void;
  /** Nach Plan-Abschluss (Items angelegt) — Caller lädt das Projekt-Detail neu. */
  onApplied: () => void;
  notify: (kind: 'success' | 'error' | 'info', text: string) => void;
}) {
  const [phase, setPhase] = useState<'setup' | 'running' | 'result'>('setup');
  const [agents, setAgents] = useState<string[]>([]);
  const [focus, setFocus] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<FeatureSuggestionItem[] | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [planTaskId, setPlanTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const a = await client.fetchCodeAgents();
      setAgents(a);
      // v889b — Projekt-preferred bevorzugen, sonst erster Agent
      if (a.length > 0) setSelectedAgents(new Set([preferredAgent && a.includes(preferredAgent) ? preferredAgent : a[0]]));
    })();
  }, [client]);

  async function start() {
    if (starting || selectedAgents.size === 0) return;
    setStarting(true);
    try {
      const r = await client.projectSuggestFeatures(projectId, {
        focus: focus.trim() || undefined,
        agents: [...selectedAgents],
      });
      if (r.ok && r.liveTaskId) {
        setTaskId(r.liveTaskId);
        setPhase('running');
      } else {
        notify('error', `Discovery-Start fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
      }
    } finally {
      setStarting(false);
    }
  }

  async function loadResult() {
    if (!taskId) return;
    const r = await client.projectSuggestResult(taskId);
    if (r.status === 'done') {
      setSuggestions(r.suggestions ?? []);
      setPhase('result');
    } else if (r.status === 'failed') {
      setResultError(r.error ?? 'Discovery fehlgeschlagen');
      setPhase('result');
    }
  }

  async function decide(s: FeatureSuggestionItem, decision: 'accept' | 'reject') {
    if (busy || planTaskId) return;
    if (decision === 'accept' && !confirm(
      `"${s.title}" annehmen?\n\nEin Plan-Lauf arbeitet den Umsetzungsplan aus (docs/feature-plan-….md) und legt die Arbeitspakete als Open-Items mit Roadmap-Milestone an (⛓-verkettet). Nutzt die CLI-Subscription.`,
    )) return;
    setBusy(true);
    try {
      const r = await client.projectFeatureDecision(projectId, {
        title: s.title,
        description: [s.value, s.rationale].filter(Boolean).join(' — ').slice(0, 800),
        decision,
      });
      if (!r.ok) {
        notify('error', `Entscheidung fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
        return;
      }
      if (decision === 'reject') {
        setDecisions(prev => new Map(prev).set(s.id, 'rejected'));
        notify('info', `"${s.title}" abgelehnt — wird nie wieder vorgeschlagen (Features-Library).`);
      } else {
        setDecisions(prev => new Map(prev).set(s.id, 'planning'));
        if (r.liveTaskId) setPlanTaskId(r.liveTaskId);
        notify('info', `🗺 Umsetzungsplan für "${s.title}" wird ausgearbeitet — Arbeitspakete erscheinen danach in der Roadmap.`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
          <h3 className="text-base font-semibold text-white">💡 Feature-Vorschläge</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
        </header>

        {phase === 'setup' && (
          <div className="p-4 space-y-3 text-xs">
            <div>
              <div className="text-gray-400 mb-1">Fokus (optional — leer = allgemein)</div>
              <input
                value={focus}
                onChange={e => setFocus(e.target.value)}
                placeholder="z.B. Community, Monetarisierung, Admin-Workflows…"
                className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200"
              />
            </div>
            <div>
              <div className="text-gray-400 mb-1">Agents (1–2 — bei zwei werden die Vorschläge unabhängig generiert und gemerged)</div>
              <div className="flex flex-wrap gap-3">
                {agents.map(a => (
                  <label key={a} className="flex items-center gap-1.5 text-gray-300">
                    <input
                      type="checkbox"
                      checked={selectedAgents.has(a)}
                      onChange={() => setSelectedAgents(prev => {
                        const n = new Set(prev);
                        if (n.has(a)) n.delete(a); else if (n.size < 2) n.add(a);
                        return n;
                      })}
                    />
                    {a}
                  </label>
                ))}
              </div>
            </div>
            <div className="text-[10px] text-gray-600">
              Read-only — es wird nichts geändert. Bereits vorhandene, geplante und früher abgelehnte Features werden ausgeklammert. Dauert einige Minuten, nutzt die CLI-Subscription{selectedAgents.size > 1 ? ' (×2 bei zwei Agents)' : ''}.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1 text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Abbrechen</button>
              <button onClick={() => void start()} disabled={starting || selectedAgents.size === 0} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">
                {starting ? '⏳ Starte…' : '💡 Vorschläge generieren'}
              </button>
            </div>
          </div>
        )}

        {phase === 'running' && taskId && (
          <div className="p-4 overflow-y-auto">
            <CodeRunLivePanel client={client} taskId={taskId} onEnded={() => { void loadResult(); }} onClose={() => { /* bleibt bis Ergebnis */ }} />
            <div className="text-[10px] text-gray-600 mt-2">Discovery läuft — die Vorschläge erscheinen hier automatisch (Ergebnis bleibt 30 min abrufbar).</div>
          </div>
        )}

        {phase === 'result' && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {resultError && <div className="text-xs text-red-400">✗ {resultError}</div>}
              {suggestions !== null && suggestions.length === 0 && !resultError && (
                <div className="text-xs text-gray-500">Keine Vorschläge — entweder ist das Projekt gut abgedeckt, oder der Fokus war zu eng.</div>
              )}
              {(suggestions ?? []).map(s => {
                const d = decisions.get(s.id);
                return (
                  <div key={s.id} className={`border rounded p-2 text-xs ${d === 'rejected' ? 'border-[#1f1f1f] opacity-50' : d ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-[#2a2a2a]'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-gray-200 font-semibold flex-1">{s.title}</span>
                      <span className={`text-[10px] ${EFFORT_META[s.effort].cls}`}>{EFFORT_META[s.effort].label}</span>
                      {s.proposedBy.length > 1 && (
                        <span className="text-[10px] text-violet-300" title={`Unabhängig vorgeschlagen von: ${s.proposedBy.join(' + ')}`}>✦ beide Agents</span>
                      )}
                    </div>
                    {s.value && <div className="text-gray-400 mb-0.5">{s.value}</div>}
                    {s.rationale && <div className="text-[10px] text-gray-600">{s.rationale}</div>}
                    <div className="flex gap-1.5 mt-1.5 justify-end">
                      {d === 'planning' && <span className="text-[10px] text-emerald-300">🗺 Plan wird ausgearbeitet…</span>}
                      {d === 'accepted' && <span className="text-[10px] text-emerald-300">✓ angenommen</span>}
                      {d === 'rejected' && <span className="text-[10px] text-gray-500">✗ abgelehnt</span>}
                      {!d && (
                        <>
                          <button onClick={() => void decide(s, 'reject')} disabled={busy || !!planTaskId} className="px-2 py-0.5 text-[10px] text-gray-400 hover:text-red-300 border border-[#2a2a2a] rounded disabled:opacity-50">✗ Ablehnen</button>
                          <button onClick={() => void decide(s, 'accept')} disabled={busy || !!planTaskId} className="px-2 py-0.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50" title="Plan-Lauf: Umsetzungsplan + Arbeitspakete als Items in der Roadmap">✓ Annehmen + planen</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Plan-Lauf-Output (ein Plan zur Zeit — Job-Guard serverseitig) */}
              {planTaskId && (
                <CodeRunLivePanel
                  client={client}
                  taskId={planTaskId}
                  onEnded={() => { setPlanTaskId(null); onApplied(); }}
                  onClose={() => setPlanTaskId(null)}
                />
              )}
            </div>
            <footer className="px-4 py-3 border-t border-[#1f1f1f] flex items-center gap-2">
              <span className="text-[10px] text-gray-600">Abgelehntes merkt sich die Features-Library dauerhaft. Ein Plan-Lauf zur Zeit.</span>
              <div className="flex-1" />
              <button onClick={onClose} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Schließen</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
