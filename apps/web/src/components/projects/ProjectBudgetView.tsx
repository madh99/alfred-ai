'use client';

/**
 * v875 — Wochen-Kosten-Budget (Soft-Limit) pro Projekt.
 *
 * Zeigt die CLI-Agent-Kosten der letzten 7 Tage (cli_agent_runs) gegen das
 * konfigurierte Soft-Budget. Überschreitung warnt (hier + beim Runner-Start),
 * blockiert aber bewusst NICHTS — sonst würde ein Budget versehentlich
 * Self-Healing oder dringende Fixes aushebeln.
 */
import { useEffect, useState } from 'react';
import type { AlfredClient, Project } from '@/lib/alfred-client';

export function ProjectBudgetView({ client, project, onProjectUpdated }: {
  client: AlfredClient;
  project: Project;
  onProjectUpdated: (p: Project) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [spent, setSpent] = useState<number | null>(null);
  const [budgetInput, setBudgetInput] = useState<string>(project.costBudgetWeeklyUsd != null ? String(project.costBudgetWeeklyUsd) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBudgetInput(project.costBudgetWeeklyUsd != null ? String(project.costBudgetWeeklyUsd) : '');
  }, [project.id, project.costBudgetWeeklyUsd]);

  useEffect(() => {
    setExpanded(false); setSpent(null); setError(null);
  }, [project.id]);

  useEffect(() => {
    if (!expanded || spent !== null) return;
    void (async () => {
      const r = await client.fetchProjectBudget(project.id);
      setSpent(r.spent7dUsd);
      setError(r.error ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const v = budgetInput.trim() === '' ? null : Number(budgetInput.replace(',', '.'));
      if (v !== null && (!Number.isFinite(v) || v <= 0)) {
        setError('Bitte einen positiven Betrag eingeben (leer = kein Budget).');
        return;
      }
      const updated = await client.updateProject(project.id, { costBudgetWeeklyUsd: v });
      if (updated) onProjectUpdated(updated);
      else setError('Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }

  const budget = project.costBudgetWeeklyUsd ?? null;
  const pct = budget && spent !== null ? Math.min(100, Math.round((spent / budget) * 100)) : null;
  const over = budget !== null && spent !== null && spent >= budget;

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5">
          <span>💸</span>
          <span>Kosten-Budget{budget !== null ? ` ($${budget.toFixed(0)}/Woche)` : ''} anzeigen</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>💸</span>
          <span>Kosten-Budget (CLI-Agents, Soft-Limit)</span>
        </h3>
        <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
      </div>

      {error && <div className="text-xs text-red-400 mb-2">✗ {error}</div>}

      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Wochen-Budget:</span>
          <span className="text-gray-500">$</span>
          <input
            type="number" min="0" step="1"
            value={budgetInput}
            onChange={e => setBudgetInput(e.target.value)}
            placeholder="kein Budget"
            className="w-24 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200 text-xs"
          />
          <button
            onClick={() => void save()}
            disabled={saving}
            className="px-2 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
          >{saving ? '…' : 'Speichern'}</button>
          <span className="text-[10px] text-gray-600">leer = kein Budget</span>
        </div>

        {spent !== null && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500">Letzte 7 Tage: <span className={over ? 'text-red-400 font-semibold' : 'text-gray-300'}>${spent.toFixed(2)}</span>{budget !== null && <span className="text-gray-600"> von ${budget.toFixed(2)}</span>}</span>
              {pct !== null && <span className={`text-[10px] ${over ? 'text-red-400' : 'text-gray-500'}`}>{pct}%</span>}
            </div>
            {budget !== null && (
              <div className="h-2 bg-[#1a1a1a] rounded overflow-hidden border border-[#2a2a2a]">
                <div
                  className={`h-full ${over ? 'bg-red-600' : (pct ?? 0) > 80 ? 'bg-amber-500' : 'bg-emerald-600'}`}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            )}
            {over && (
              <div className="text-[10px] text-red-400 mt-1">
                ⚠ Budget überschritten — neue Agent-Läufe starten weiterhin (Soft-Limit), warnen aber beim Start.
              </div>
            )}
          </div>
        )}
        {spent === null && !error && <div className="text-gray-600">Lade Kosten…</div>}
      </div>
    </div>
  );
}
