'use client';

/**
 * v872 — Health-Verlauf: Trend-Visualisierung über project_health_log.
 *
 * Die Daten + der Endpoint (GET /api/projects/:id/health-log) + die
 * Client-Methode existierten seit v6xx — es gab nur keine UI, die sie nutzt.
 * Pro Probe eine Punkte-Reihe (alt → neu, Farbe = Status) plus Mini-Balken
 * für die Build-Dauer (Ausreißer = Regressions-Hinweis).
 */
import { useState } from 'react';
import type { AlfredClient, ProjectHealthEntry, HealthProbe } from '@/lib/alfred-client';

const DOT_COLOR: Record<string, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
  skipped: 'bg-gray-700',
};

const PROBES: HealthProbe[] = ['git', 'build', 'deps', 'http'];
const MAX_POINTS = 40;

export function HealthTrendView({ client, projectId }: { client: AlfredClient; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ProjectHealthEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && entries === null && !loading) {
      setLoading(true);
      try {
        const log = await client.fetchProjectHealthLog(projectId, 200);
        setEntries(log);
      } finally {
        setLoading(false);
      }
    }
  }

  // Gruppierung pro Probe, chronologisch alt → neu, auf MAX_POINTS gekappt
  const byProbe = (probe: HealthProbe): ProjectHealthEntry[] => {
    if (!entries) return [];
    return entries
      .filter(e => e.probe === probe)
      .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
      .slice(-MAX_POINTS);
  };

  const buildEntries = byProbe('build');
  const maxBuildMs = Math.max(1, ...buildEntries.map(e => e.durationMs));

  return (
    <div className="mt-2">
      <button
        onClick={() => void toggle()}
        className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300"
        title="Verlauf der Health-Checks (Status pro Probe + Build-Dauer über Zeit)"
      >
        <span className="text-[9px]">{expanded ? '▼' : '▶'}</span>
        <span>📈 Verlauf</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {loading && <div className="text-xs text-gray-600">Lade Verlauf…</div>}
          {!loading && entries !== null && entries.length === 0 && (
            <div className="text-xs text-gray-600">Noch keine Health-Log-Einträge.</div>
          )}
          {!loading && entries !== null && entries.length > 0 && (
            <>
              {PROBES.map(probe => {
                const list = byProbe(probe);
                if (list.length === 0) return null;
                return (
                  <div key={probe} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 font-mono w-12 shrink-0">{probe}</span>
                    <div className="flex items-center gap-[3px] flex-wrap">
                      {list.map(e => (
                        <span
                          key={e.id}
                          className={`inline-block w-2 h-2 rounded-full ${DOT_COLOR[e.status] ?? 'bg-gray-700'}`}
                          title={`${new Date(e.checkedAt).toLocaleString('de-AT')} — ${e.status}${e.details ? ` · ${e.details.slice(0, 140)}` : ''}`}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Build-Dauer als Mini-Balken — Ausreißer nach oben fallen sofort auf */}
              {buildEntries.length > 1 && (
                <div className="flex items-end gap-2 pt-1">
                  <span className="text-[10px] text-gray-500 font-mono w-12 shrink-0">⏱ build</span>
                  <div className="flex items-end gap-[3px] h-8">
                    {buildEntries.map(e => (
                      <span
                        key={e.id}
                        className={`inline-block w-2 rounded-sm ${e.status === 'ok' ? 'bg-cyan-700' : 'bg-red-700'}`}
                        style={{ height: `${Math.max(8, Math.round((e.durationMs / maxBuildMs) * 100))}%` }}
                        title={`${new Date(e.checkedAt).toLocaleString('de-AT')} — ${(e.durationMs / 1000).toFixed(1)}s (${e.status})`}
                      />
                    ))}
                  </div>
                  <span className="text-[10px] text-gray-600">max {(maxBuildMs / 1000).toFixed(1)}s</span>
                </div>
              )}

              <div className="text-[10px] text-gray-700">letzte {Math.min(MAX_POINTS, Math.max(...PROBES.map(p => byProbe(p).length)))} Checks, alt → neu</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
