'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectWorkStats } from '@/lib/alfred-client';

interface Props {
  projectId: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function typeLabel(t: string): string {
  return ({
    project_agent: '🤖 Project-Agent',
    code_agent: '⚙️ Code-Agent',
    brainstorming: '💡 Brainstorming',
    delegate: '↪ Delegate',
  } as Record<string, string>)[t] ?? t;
}

/** v866 — kompakte Token-Anzeige: 1234 → "1.2k", 2500000 → "2.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * v658 — Work-Stats: Gesamt-Arbeitszeit aller Sessions pro Projekt, aufgeteilt
 * nach Session-Type und Agent (claude-code, codex, etc.).
 */
export function ProjectWorkStatsView({ projectId }: Props) {
  const { client } = useConfig();
  const [stats, setStats] = useState<ProjectWorkStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const s = await client.fetchProjectWorkStats(projectId);
      setStats(s);
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    if (expanded && !stats) load();
  }, [expanded, stats, load]);

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▸</span>
          <span>📊 Arbeitszeit-Statistik</span>
          <span className="text-[10px] text-gray-600 font-normal">— byType + byAgent</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▾</span>
          <span>📊 Arbeitszeit-Statistik</span>
        </button>
        <button
          onClick={load}
          disabled={loading}
          title="Neu laden"
          className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
        >↻</button>
      </div>

      {!stats && loading && <div className="text-xs text-gray-500 italic">Lade…</div>}
      {stats && (
        <div className="space-y-3">
          {/* Total — v668: failedCount-Spalte ergänzt */}
          <div className="bg-[#0f0f0f] border border-[#222] rounded p-3 grid grid-cols-4 gap-2 text-xs">
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Gesamtzeit</div>
              <div className="text-base font-semibold text-blue-400">{formatDuration(stats.total.totalSeconds)}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Sessions</div>
              <div className="text-base font-semibold text-gray-200">{stats.total.count}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Laufend</div>
              <div className="text-base font-semibold text-emerald-400">{stats.total.runningCount}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Abgebrochen</div>
              <div className={`text-base font-semibold ${(stats.total.failedCount ?? 0) > 0 ? 'text-red-400' : 'text-gray-500'}`}>{stats.total.failedCount ?? 0}</div>
            </div>
          </div>

          {/* v866 — CLI-Token-Usage (eigene Subscriptions/Keys — nicht in Alfred-Betriebskosten) */}
          {(stats.total.tokensIn ?? 0) + (stats.total.tokensOut ?? 0) > 0 && (
            <div className="bg-[#0f0f0f] border border-[#222] rounded p-3 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Tokens In</div>
                <div className="text-base font-semibold text-gray-200">{formatTokens(stats.total.tokensIn ?? 0)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Tokens Out</div>
                <div className="text-base font-semibold text-gray-200">{formatTokens(stats.total.tokensOut ?? 0)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5" title="API-Äquivalent laut CLI — eigene Subscription/Key, nicht in Alfred-Betriebskosten">Kosten-Äquiv.</div>
                <div className="text-base font-semibold text-amber-400">${(stats.total.costUsd ?? 0).toFixed(2)}</div>
              </div>
            </div>
          )}

          {/* byType — v668: fertig/abgebrochen separat anzeigen */}
          {stats.byType.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Nach Typ</div>
              <div className="space-y-0.5">
                {stats.byType.map(t => {
                  const failed = t.failedCount ?? 0;
                  const counts = failed > 0
                    ? `${t.count} (${t.completedCount} ✓, ${failed} ✗)`
                    : `${t.count} (${t.completedCount} fertig)`;
                  return (
                    <div key={t.sessionType} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 text-gray-300">{typeLabel(t.sessionType)}</span>
                      {/* v866 — Tokens pro Typ (nur wenn Daten vorhanden — ab v866-Deploy) */}
                      {(t.tokensIn ?? 0) + (t.tokensOut ?? 0) > 0 && (
                        <span className="text-gray-500 text-[10px] font-mono" title={`Tokens in/out · Kosten-Äquivalent $${(t.costUsd ?? 0).toFixed(2)}`}>
                          {formatTokens(t.tokensIn ?? 0)}↓ {formatTokens(t.tokensOut ?? 0)}↑
                        </span>
                      )}
                      <span className="text-gray-500 text-[10px]" title={failed > 0 ? `${failed} abgebrochen/fehlgeschlagen` : undefined}>{counts}</span>
                      <span className="font-mono text-blue-400">{formatDuration(t.totalSeconds)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* byAgent */}
          {stats.byAgent.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Nach Agent</div>
              <div className="space-y-0.5">
                {stats.byAgent.map(a => (
                  <div key={a.agent} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 font-mono text-gray-300">{a.agent}</span>
                    <span className="text-gray-500 text-[10px]">{a.count}</span>
                    <span className="font-mono text-blue-400">{formatDuration(a.totalSeconds)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* v866 — Agent / CLI-Version / Modell (aus cli_agent_runs, ab v866-Deploy) */}
          {stats.byAgentDetail && stats.byAgentDetail.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1" title="CLI-Binary-Version · Modell — Daten ab v866; eigene Subscriptions/Keys">
                Nach Agent / Version / Modell
              </div>
              <div className="space-y-0.5">
                {stats.byAgentDetail.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-gray-300">{d.agent}</span>
                    <span className="flex-1 text-gray-500 text-[10px] font-mono truncate" title={d.detail}>{d.detail}</span>
                    <span className="text-gray-500 text-[10px] font-mono" title={`Kosten-Äquivalent $${d.costUsd.toFixed(2)}`}>
                      {formatTokens(d.tokensIn)}↓ {formatTokens(d.tokensOut)}↑
                    </span>
                    <span className="text-gray-500 text-[10px]">{d.runs}</span>
                    <span className="font-mono text-blue-400">{formatDuration(d.durationS)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.byType.length === 0 && stats.byAgent.length === 0 && (
            <div className="text-xs text-gray-600 italic">Noch keine Sessions registriert.</div>
          )}
        </div>
      )}
    </div>
  );
}
