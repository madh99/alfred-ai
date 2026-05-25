'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import { AgentEventCard, type AgentEventEntry } from './AgentEventCards';

/**
 * v791 — Replay-Modal: alle persistierten Events einer Session chronologisch.
 *
 * Readonly — keine Polling, kein Update. Snapshot zum Zeitpunkt des Modal-Open.
 * Events werden über die gleichen AgentEventCards gerendert wie der Live-Stream
 * (Konsistenz: User sieht historisch dasselbe Format wie live).
 *
 * Iterations werden als Sub-Sections gruppiert mit Header "▼ Iteration N".
 */

interface ReplayEvent {
  id: string;
  iteration: number;
  eventType: string;
  eventData: any;
  createdAt: string;
}

interface AgentSessionReplayModalProps {
  sessionId: string;
  /** Anzeigename z.B. "claude-code · abc12345…" für Modal-Header */
  title: string;
  onClose: () => void;
}

export function AgentSessionReplayModal({ sessionId, title, onClose }: AgentSessionReplayModalProps) {
  const { client } = useConfig();
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedIters, setCollapsedIters] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.fetchAgentSessionEvents(sessionId, 1000)
      .then(data => {
        if (cancelled) return;
        setEvents(data);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, sessionId]);

  // Gruppieren nach Iteration
  const byIteration = new Map<number, ReplayEvent[]>();
  for (const e of events) {
    const arr = byIteration.get(e.iteration) ?? [];
    arr.push(e);
    byIteration.set(e.iteration, arr);
  }
  const iterations = Array.from(byIteration.keys()).sort((a, b) => a - b);

  function toggleIter(iter: number) {
    setCollapsedIters(prev => {
      const next = new Set(prev);
      if (next.has(iter)) next.delete(iter); else next.add(iter);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#1a1a1a]">
          <div>
            <div className="text-sm font-semibold text-gray-200">📜 Session-Replay</div>
            <div className="text-[11px] text-gray-500 font-mono">{title}</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[11px] text-gray-500">
              {loading ? 'Lade…' : `${events.length} Events · ${iterations.length} Iteration(en)`}
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-white/5"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {loading && (
            <div className="text-center text-gray-500 text-sm py-8">Lade Events…</div>
          )}
          {error && (
            <div className="bg-red-500/10 border border-red-500/40 text-red-300 text-sm rounded p-2">
              Fehler: {error}
            </div>
          )}
          {!loading && events.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-8 italic">
              Keine Events für diese Session persistiert (möglicherweise wurde die Session vor v780 erstellt oder enthielt keinen vollständigen Run).
            </div>
          )}
          {iterations.map(iter => {
            const iterEvents = byIteration.get(iter) ?? [];
            const collapsed = collapsedIters.has(iter);
            // Stats pro Iteration: zähle event-types
            const counts: Record<string, number> = {};
            for (const e of iterEvents) counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
            const summary = Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' · ');
            return (
              <div key={iter} className="border border-[#1a1a1a] rounded">
                <button
                  onClick={() => toggleIter(iter)}
                  className="w-full flex items-center justify-between px-3 py-1.5 bg-[#0f0f0f] hover:bg-[#141414] text-left"
                >
                  <span className="text-xs font-semibold text-gray-300">
                    {collapsed ? '▶' : '▼'} Iteration {iter}
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono">{summary}</span>
                </button>
                {!collapsed && (
                  <div className="p-2 space-y-1 bg-[#080808]">
                    {iterEvents.map(e => {
                      const entry: AgentEventEntry = {
                        ts: new Date(e.createdAt).getTime(),
                        type: e.eventType,
                        data: e.eventData,
                      };
                      return (
                        <div key={e.id} className="flex gap-2 items-start">
                          <span className="text-[9px] text-gray-600 font-mono pt-1 shrink-0 w-16">
                            {new Date(e.createdAt).toLocaleTimeString('de-AT', { hour12: false })}
                          </span>
                          <div className="flex-1 min-w-0">
                            <AgentEventCard entry={entry} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
