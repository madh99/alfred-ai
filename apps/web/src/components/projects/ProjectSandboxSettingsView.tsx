'use client';

import { useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { Project } from '@/lib/alfred-client';

interface Props {
  project: Project;
  onUpdated?: (project: Project) => void;
}

/**
 * v849 — Sandbox-Settings pro Projekt.
 *
 * Drei opt-in Settings für Compose-Stack-Sandboxen:
 *   - sandboxMode: single | compose
 *   - persistDbVolumes: false | true (nur relevant bei compose)
 *   - dbSeedStrategy: none | first-start-only | every-start
 *
 * Strict opt-in: Default 'single' erhält pre-v849 Verhalten 1:1 für alle
 * bestehenden Projekte. User aktiviert compose manuell.
 */
export function ProjectSandboxSettingsView({ project, onUpdated }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMode = project.sandboxMode ?? 'single';
  const currentPersist = Boolean(project.persistDbVolumes);
  const currentSeed = project.dbSeedStrategy ?? 'first-start-only';

  async function patch(fields: { sandboxMode?: 'single' | 'compose'; persistDbVolumes?: boolean; dbSeedStrategy?: 'none' | 'first-start-only' | 'every-start' }) {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await client.updateProject(project.id, fields as unknown as Record<string, unknown>);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5"
        >
          <span>🧪</span>
          <span>Sandbox-Modus: {currentMode === 'compose' ? '🐳 Compose-Stack' : '📦 Single-Container (Default)'}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>🧪</span>
          <span>Sandbox-Einstellungen</span>
        </h3>
        <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
      </div>

      <div className="space-y-3 text-[11px]">
        {/* sandboxMode */}
        <div>
          <div className="text-gray-300 mb-1 font-medium">Sandbox-Modus</div>
          <div className="flex gap-2">
            <button
              onClick={() => patch({ sandboxMode: 'single' })}
              disabled={saving}
              className={`px-2 py-1 rounded border ${
                currentMode === 'single'
                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                  : 'border-[#222] text-gray-400 hover:border-[#333]'
              } disabled:opacity-50`}
            >
              📦 Single-Container
            </button>
            <button
              onClick={() => patch({ sandboxMode: 'compose' })}
              disabled={saving}
              className={`px-2 py-1 rounded border ${
                currentMode === 'compose'
                  ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                  : 'border-[#222] text-gray-400 hover:border-[#333]'
              } disabled:opacity-50`}
            >
              🐳 Compose-Stack
            </button>
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            {currentMode === 'single'
              ? 'Ein Container mit Node + dev-server. Standard für Frontend-/API-Projekte ohne DB.'
              : 'Multi-Service-Stack via docker-compose.yml. Für Projekte mit DB/Redis/etc. Erfordert ≥4 GB Host-RAM.'}
          </div>
        </div>

        {/* persistDbVolumes — nur bei compose relevant */}
        {currentMode === 'compose' && (
          <div>
            <div className="text-gray-300 mb-1 font-medium">DB-Volumes</div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={currentPersist}
                onChange={(e) => patch({ persistDbVolumes: e.target.checked })}
                disabled={saving}
                className="accent-purple-500"
              />
              <span className="text-gray-300">Persistent (überleben Sandbox-Discard)</span>
            </label>
            <div className="text-[10px] text-gray-500 mt-1">
              {currentPersist
                ? '⚠ Volumes pro Projekt geteilt — Test-Migrations können produktion-mock verseuchen'
                : 'Volumes ephemer pro Sandbox — Discard löscht alle Daten (empfohlen für Tests)'}
            </div>
          </div>
        )}

        {/* dbSeedStrategy */}
        <div>
          <div className="text-gray-300 mb-1 font-medium">DB-Seed-Strategie</div>
          <select
            value={currentSeed}
            onChange={(e) => patch({ dbSeedStrategy: e.target.value as 'none' | 'first-start-only' | 'every-start' })}
            disabled={saving}
            className="bg-[#0a0a0a] border border-[#222] rounded px-2 py-1 text-gray-300 disabled:opacity-50"
          >
            <option value="none">Nie automatisch</option>
            <option value="first-start-only">Nur beim ersten Start (Default)</option>
            <option value="every-start">Bei jedem Start</option>
          </select>
        </div>

        {error && (
          <div className="text-[10px] text-red-400 bg-red-500/10 rounded px-2 py-1">{error}</div>
        )}
      </div>
    </div>
  );
}
