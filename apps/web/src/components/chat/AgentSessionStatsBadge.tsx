'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

/**
 * v788 — Kompakter Stats-Badge zeigt aktuelle Session-Stats für (sandbox × selectedAgent).
 *
 * Klick expandiert ein Popover mit ALLEN Sessions der Sandbox (inkl. anderer Agents).
 * Pollt periodisch (alle 8s) damit stats live aktualisieren während Run läuft.
 */

interface AgentSessionStats {
  id: string;
  agentName: string;
  cliSessionId?: string;
  status: string;
  messageCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  startedAt: string;
  lastUsedAt: string;
}

interface AgentSessionStatsBadgeProps {
  sandboxId: string;
  selectedAgent?: string;
  /** Inkrement zum Triggern eines Refresh (z.B. nach Send-Klick). */
  refreshKey?: number;
}

const POLL_INTERVAL_MS = 8_000;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function AgentSessionStatsBadge({ sandboxId, selectedAgent, refreshKey }: AgentSessionStatsBadgeProps) {
  const { client } = useConfig();
  const [sessions, setSessions] = useState<AgentSessionStats[]>([]);
  const [expanded, setExpanded] = useState(false);
  // v789 — Reset-State pro Session-ID
  const [resetting, setResetting] = useState<string | null>(null);
  const [internalRefresh, setInternalRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      if (cancelled) return;
      const data = await client.fetchAgentSessions(sandboxId);
      if (cancelled) return;
      setSessions(data);
    }
    load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [client, sandboxId, refreshKey, internalRefresh]);

  // v789 — Reset-Handler
  async function handleReset(session: AgentSessionStats) {
    const lossWarning = session.messageCount > 0
      ? `\n\nDamit gehen ${session.messageCount} Iteration(en) im CLI-Kontext verloren (Tool-Call-Cache, Conversation, --resume-ID).\nGesamt-Stats: ${session.messageCount}× · in ${session.totalTokensInput} / out ${session.totalTokensOutput} tokens · $${session.totalCostUsd.toFixed(4)}`
      : '';
    if (!confirm(`Session "${session.agentName}" zurücksetzen?${lossWarning}\n\nNächster Run startet frisch — der Agent muss den Code wieder von vorne explorieren.`)) {
      return;
    }
    setResetting(session.id);
    try {
      const r = await client.resetAgentSession(sandboxId, session.agentName);
      if (!r.ok) {
        alert(`Reset fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
      } else {
        // Trigger reload sodass Session aus Liste verschwindet
        setInternalRefresh(k => k + 1);
      }
    } finally {
      setResetting(null);
    }
  }

  const current = sessions.find(s => s.agentName === selectedAgent && s.status === 'active');

  if (!current && sessions.length === 0) {
    return (
      <span className="text-[10px] text-gray-500 italic" title="Noch keine Session — nach erstem Run erscheinen Stats">
        no session
      </span>
    );
  }

  if (!current) {
    return (
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-gray-500 hover:text-gray-300"
        title="Andere Sessions in dieser Sandbox sind verfügbar"
      >
        📊 {sessions.length} other
      </button>
    );
  }

  const totalTokens = current.totalTokensInput + current.totalTokensOutput;
  const cacheRatio = current.totalTokensInput > 0
    ? Math.round((current.totalCachedTokens / current.totalTokensInput) * 100)
    : 0;

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-200 px-2 py-1 border border-[#1a1a1a] rounded hover:border-[#2a2a2a]"
        title={`Session läuft seit ${relativeTime(current.startedAt)}\n${current.messageCount} Iterationen · letzter Run vor ${relativeTime(current.lastUsedAt)}\nCache-Hit: ${cacheRatio}%`}
      >
        <span>📊</span>
        <span className="font-mono">{current.messageCount}×</span>
        <span className="text-gray-500">·</span>
        <span className="font-mono">{fmtTokens(totalTokens)} tok</span>
        {current.totalCachedTokens > 0 && (
          <>
            <span className="text-gray-500">·</span>
            <span className="font-mono text-emerald-400/70" title={`${cacheRatio}% cached`}>{fmtTokens(current.totalCachedTokens)} ⚡</span>
          </>
        )}
        <span className="text-gray-500">·</span>
        <span className="font-mono">{fmtCost(current.totalCostUsd)}</span>
      </button>

      {expanded && (
        <div className="absolute bottom-full right-0 mb-1 w-[360px] bg-[#0a0a0a] border border-[#2a2a2a] rounded shadow-xl p-2 z-50">
          <div className="text-[10px] text-gray-500 mb-1 px-1">Sessions in dieser Sandbox:</div>
          <div className="space-y-1">
            {sessions.map(s => {
              const isCurrent = s.id === current.id;
              const tot = s.totalTokensInput + s.totalTokensOutput;
              return (
                <div
                  key={s.id}
                  className={`text-[10px] p-1.5 rounded ${isCurrent ? 'bg-purple-500/10 border border-purple-500/40' : 'bg-[#0f0f0f] border border-[#1a1a1a]'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{s.agentName}</span>
                    <span className={`text-[9px] px-1 rounded ${s.status === 'active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-gray-500/20 text-gray-400'}`}>{s.status}</span>
                    {s.cliSessionId && (
                      <span className="text-[9px] text-gray-500 font-mono" title="CLI Session-ID">{s.cliSessionId.slice(0, 8)}…</span>
                    )}
                    {/* v789 — Reset-Button für active Sessions */}
                    {s.status === 'active' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleReset(s); }}
                        disabled={resetting === s.id}
                        title={`Session zurücksetzen — ${s.agentName} startet beim nächsten Run frisch, ohne --resume. Tool-Call-Cache + Conversation gehen verloren.`}
                        className="ml-auto text-[10px] text-red-400/70 hover:text-red-300 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition disabled:opacity-30"
                      >
                        {resetting === s.id ? '⏳' : '🗑'}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-gray-400">
                    <span>{s.messageCount} iter</span>
                    <span className="text-gray-600">·</span>
                    <span>in {fmtTokens(s.totalTokensInput)}</span>
                    <span className="text-gray-600">·</span>
                    <span>out {fmtTokens(s.totalTokensOutput)}</span>
                    {s.totalCachedTokens > 0 && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span className="text-emerald-400/80">cache {fmtTokens(s.totalCachedTokens)}</span>
                      </>
                    )}
                    <span className="text-gray-600">·</span>
                    <span>{fmtCost(s.totalCostUsd)}</span>
                    <span className="ml-auto text-gray-600">{relativeTime(s.lastUsedAt)} ago</span>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setExpanded(false)}
            className="mt-1 text-[10px] text-gray-500 hover:text-gray-300 w-full text-center py-0.5"
          >
            schließen
          </button>
        </div>
      )}
    </div>
  );
}
