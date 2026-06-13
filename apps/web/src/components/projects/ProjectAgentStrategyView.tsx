'use client';

/**
 * v889b — CLI-Agent-Strategie pro Projekt.
 *
 * Steuert, welche CLI (claude-code/codex/mistral-vibe) ein Lauf in DIESEM
 * Projekt nutzt — und wie ausgewichen wird, wenn die bevorzugte CLI gerade
 * in einem anderen Projekt läuft (geteiltes Provider-Kontingent).
 *  - auto:   preferred nehmen; ist sie belegt, fallbackOrder der Reihe nach
 *  - manual: bei interaktiven Starts wird im jeweiligen Picker gewählt; an
 *            automatischen Läufen (Cron/Reflector) Fallback auf auto/preferred
 */
import { useEffect, useState } from 'react';
import type { AlfredClient, Project } from '@/lib/alfred-client';

type Strategy = NonNullable<Project['agentStrategy']>;

export function ProjectAgentStrategyView({ client, project, onUpdated }: {
  client: AlfredClient;
  project: Project;
  onUpdated: (p: Project) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState<Array<{ cli: string; projectId: string; kind: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strat: Strategy = project.agentStrategy ?? { mode: 'auto' };
  const preferred = strat.preferred ?? agents[0] ?? '';
  // Ausweich-Reihenfolge: gespeicherte, sonst alle außer preferred
  const fallbackOrder = strat.fallbackOrder ?? agents.filter(a => a !== preferred);

  useEffect(() => {
    if (!expanded) return;
    void (async () => {
      setAgents(await client.fetchCodeAgents());
      setBusy(await client.fetchAgentBusy());
    })();
  }, [expanded, client]);

  async function save(next: Strategy) {
    setSaving(true); setError(null);
    try {
      const updated = await client.updateProject(project.id, { agentStrategy: next });
      if (updated) onUpdated(updated);
      else setError('Speichern fehlgeschlagen.');
    } finally { setSaving(false); }
  }

  function moveFallback(idx: number, dir: -1 | 1) {
    const list = [...fallbackOrder];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    void save({ mode: strat.mode, preferred, fallbackOrder: list });
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5">
          <span>🔀</span>
          <span>CLI-Strategie ({strat.mode === 'auto' ? `auto · ${preferred || '–'}` : 'manuell'}) anzeigen</span>
        </button>
      </div>
    );
  }

  const busyClis = new Set(busy.map(b => b.cli));

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><span>🔀</span><span>CLI-Strategie</span></h3>
        <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
      </div>
      {error && <div className="text-xs text-red-400 mb-2">✗ {error}</div>}

      <div className="space-y-3 text-xs">
        {/* Modus */}
        <div>
          <div className="text-gray-500 mb-1">Modus</div>
          <div className="flex gap-1">
            {(['auto', 'manual'] as const).map(m => (
              <button key={m} disabled={saving}
                onClick={() => void save({ mode: m, preferred, fallbackOrder })}
                className={`px-2 py-1 rounded border ${strat.mode === m ? 'bg-purple-500/20 text-purple-300 border-purple-500/40' : 'bg-[#1a1a1a] text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}>
                {m === 'auto' ? 'auto (Standard + Ausweichen)' : 'manuell (pro Lauf wählen)'}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-gray-600 mt-1">
            {strat.mode === 'auto'
              ? 'Nutzt die bevorzugte CLI; läuft sie gerade in einem anderen Projekt, wird der Reihe nach ausgewichen.'
              : 'Interaktive Läufe (Abarbeiten/Review/…) fragen die CLI ab; automatische Läufe (Cron/Reflector) fallen auf auto/preferred zurück (vermerkt).'}
          </div>
        </div>

        {/* Bevorzugte CLI */}
        <div>
          <div className="text-gray-500 mb-1">Bevorzugte CLI</div>
          <select value={preferred} disabled={saving}
            onChange={e => void save({ mode: strat.mode, preferred: e.target.value, fallbackOrder: agents.filter(a => a !== e.target.value) })}
            className="px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200">
            {agents.map(a => <option key={a} value={a}>{a}{busyClis.has(a) ? ' (läuft gerade)' : ''}</option>)}
          </select>
        </div>

        {/* Ausweich-Reihenfolge (nur auto) */}
        {strat.mode === 'auto' && fallbackOrder.length > 0 && (
          <div>
            <div className="text-gray-500 mb-1">Ausweich-Reihenfolge</div>
            <div className="space-y-0.5">
              {fallbackOrder.map((a, i) => (
                <div key={a} className="flex items-center gap-2">
                  <span className="text-gray-600 w-4">{i + 1}.</span>
                  <span className="flex-1 font-mono text-gray-300">{a}{busyClis.has(a) ? <span className="text-amber-400"> ⚠ läuft</span> : ''}</span>
                  <button disabled={saving || i === 0} onClick={() => moveFallback(i, -1)} className="text-gray-500 hover:text-gray-200 disabled:opacity-30">↑</button>
                  <button disabled={saving || i === fallbackOrder.length - 1} onClick={() => moveFallback(i, 1)} className="text-gray-500 hover:text-gray-200 disabled:opacity-30">↓</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Aktuell laufende CLIs */}
        {busy.length > 0 && (
          <div className="text-[10px] text-gray-600">
            Aktiv: {busy.map(b => `${b.cli} (${b.kind})`).join(' · ')}
          </div>
        )}
        {agents.length <= 1 && <div className="text-[10px] text-gray-600">Nur eine CLI konfiguriert — Ausweichen nicht möglich.</div>}
      </div>
    </div>
  );
}
