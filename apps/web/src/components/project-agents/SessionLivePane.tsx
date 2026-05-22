'use client';

import { useEffect, useState, useRef } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectAgentSession } from '@/lib/alfred-client';
import { SandboxPanel } from './SandboxPanel';

const PHASE_BADGES: Record<string, string> = {
  planning: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  coding: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
  building: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  fixing: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
  validating: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',
  done: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  failed: 'bg-red-500/20 text-red-400 border-red-500/40',
};

function sessionDuration(s: { createdAt: string; updatedAt: string; currentPhase: string }): { label: string; running: boolean } {
  const start = new Date(s.createdAt).getTime();
  const isTerminal = s.currentPhase === 'done' || s.currentPhase === 'failed';
  const end = isTerminal ? new Date(s.updatedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  let label: string;
  if (sec < 60) label = `${sec}s`;
  else if (sec < 3600) label = `${Math.floor(sec / 60)}m ${sec % 60}s`;
  else if (sec < 86400) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); label = m > 0 ? `${h}h ${m}m` : `${h}h`; }
  else { const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); label = h > 0 ? `${d}d ${h}h` : `${d}d`; }
  return { label, running: !isTerminal };
}

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface Props {
  session: ProjectAgentSession;
  onClose?: () => void;
  onChanged?: () => void;
  /** v690 — kompakt: kürzere Section-Spacing für Embed-Use-Cases (z.B. ProjectChat-Side-Panel) */
  compact?: boolean;
  /** v699 — Project-ID für Sandbox-Panel (nur dann sichtbar wenn gesetzt). */
  projectId?: string;
}

/**
 * v690 — Wiederverwendbares Session-Detail-Panel.
 * Ursprünglich Inline in ProjectAgentsPage.tsx (200 LOC), extrahiert damit der
 * ProjectChat-Expand-Mode dieselbe Live-View embedden kann.
 *
 * Features:
 *  - Header: Task-ID, Goal, Phase, Build, Iteration, Files, cwd, Agent, Commit
 *  - Milestones-Liste
 *  - Zeitstempel: Gestartet / Aktualisiert / Dauer (live)
 *  - Failure-Insight bei done/failed
 *  - Live-Output via SSE (nur bei nicht-terminal)
 *  - Interject-Input (nur bei laufend)
 *  - Stop-Button (laufend) / Resume-Button (done/failed)
 */
export function SessionLivePane({ session, onClose, onChanged, compact, projectId }: Props) {
  const { client } = useConfig();
  const [liveLines, setLiveLines] = useState<Array<{ ts: number; source: string; text: string }>>([]);
  const [interjectText, setInterjectText] = useState('');
  const [interjectBusy, setInterjectBusy] = useState(false);
  const outputBoxRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Live-Output SSE
  useEffect(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setLiveLines([]);
    if (!client) return;
    if (session.currentPhase === 'done' || session.currentPhase === 'failed') return;
    const es = client.openProjectAgentOutputStream(
      session.taskId,
      (line) => {
        setLiveLines((prev) => {
          const next = [...prev, line];
          return next.length > 800 ? next.slice(next.length - 800) : next;
        });
      },
      (history) => setLiveLines(history),
    );
    esRef.current = es;
    return () => { es.close(); };
  }, [client, session.taskId, session.currentPhase]);

  useEffect(() => {
    const box = outputBoxRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [liveLines]);

  async function handleInterject() {
    if (!client || !interjectText.trim()) return;
    setInterjectBusy(true);
    try {
      const r = await client.interjectProjectAgent(session.taskId, interjectText.trim());
      if (r.ok) setInterjectText('');
      else alert(`Interjection fehlgeschlagen: ${r.error}`);
    } finally { setInterjectBusy(false); }
  }

  async function handleStop() {
    if (!client) return;
    if (!confirm('Diese Project-Agent-Session wirklich stoppen?')) return;
    const ok = await client.stopProjectAgent(session.taskId);
    if (ok) onChanged?.();
    else alert('Stop fehlgeschlagen.');
  }

  async function handleResume() {
    if (!client) return;
    const notes = prompt('Optional: Hinweis für den neuen Agent\nLeer = Standard-Continuation.');
    if (notes === null) return;
    const r = await client.resumeProjectAgent(session.taskId, notes.trim() || undefined);
    if (r.ok) {
      alert(`▶ Resume gestartet: neue Session ${r.taskId?.slice(0, 8)}`);
      onChanged?.();
    } else {
      alert(`Resume fehlgeschlagen: ${r.error}`);
    }
  }

  const isTerminal = session.currentPhase === 'done' || session.currentPhase === 'failed';
  const spacing = compact ? 'space-y-3' : 'space-y-4';

  return (
    <div className={`text-sm ${spacing}`}>
      {onClose && (
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-gray-100">Session Detail</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">×</button>
        </div>
      )}

      <div>
        <div className="text-[10px] text-gray-500 mb-0.5">Task ID</div>
        <div className="font-mono text-[11px] text-gray-300 break-all">{session.taskId}</div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 mb-0.5">Ziel</div>
        <div className="text-gray-200 whitespace-pre-wrap text-xs">{session.goal}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Phase</div>
          <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${PHASE_BADGES[session.currentPhase] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>{session.currentPhase}</span>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Build</div>
          <div className="text-gray-200">{session.lastBuildPassed ? '✅ passed' : '🔴 not passed'}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Iteration</div>
          <div className="text-gray-200">{session.currentIteration}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Files changed</div>
          <div className="text-gray-200">{session.totalFilesChanged}</div>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 mb-0.5">Working Directory</div>
        <div className="font-mono text-[10px] text-gray-300 break-all">{session.cwd}</div>
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-[10px] text-gray-500 mb-0.5">Agent</div>
            <div className="font-mono text-[10px] text-gray-300">{session.agentName}</div>
          </div>
          {session.lastCommitSha && (
            <div>
              <div className="text-[10px] text-gray-500 mb-0.5">Last commit</div>
              <div className="font-mono text-[10px] text-gray-300">{session.lastCommitSha.slice(0, 12)}</div>
            </div>
          )}
        </div>
      )}

      {session.milestones.length > 0 && !compact && (
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Milestones ({session.milestones.length})</div>
          <ul className="text-[11px] text-gray-400 space-y-0.5 max-h-40 overflow-y-auto">
            {session.milestones.map((m, i) => (<li key={i} className="border-l-2 border-[#2a2a2a] pl-2">{m}</li>))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-[10px] pt-1">
        <div>
          <div className="text-gray-500 mb-0.5">Gestartet</div>
          <div className="text-gray-400">{formatDateTime(session.createdAt)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">{isTerminal ? 'Beendet' : 'Aktualisiert'}</div>
          <div className="text-gray-400">{formatDateTime(session.updatedAt)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Dauer</div>
          {(() => {
            const d = sessionDuration(session);
            return <div className={d.running ? 'text-emerald-400 font-mono' : 'text-blue-400 font-mono'}>⏱ {d.label}{d.running ? ' (läuft)' : ''}</div>;
          })()}
        </div>
      </div>

      {(session as { failureInsight?: string }).failureInsight && (
        <div className="p-2 bg-amber-500/5 border border-amber-500/40 rounded text-[11px] text-amber-200 whitespace-pre-wrap">
          <div className="text-amber-400 font-semibold mb-1">💡 Lessons</div>
          {(session as { failureInsight?: string }).failureInsight}
        </div>
      )}

      {!isTerminal && (
        <div className="space-y-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">
            Live Output {liveLines.length > 0 && <span className="text-gray-400">({liveLines.length} Zeilen)</span>}
          </div>
          <div ref={outputBoxRef} className={`bg-black/60 border border-gray-700 rounded p-2 text-[11px] font-mono ${compact ? 'h-64' : 'h-48'} overflow-y-auto whitespace-pre-wrap`}>
            {liveLines.length === 0 ? (
              <div className="text-gray-600 italic">Warte auf Output…</div>
            ) : (
              liveLines.map((l, i) => (
                <div
                  key={i}
                  className={l.source === 'stderr' ? 'text-red-300' : l.source === 'system' ? 'text-blue-300' : 'text-gray-300'}
                >{l.text}</div>
              ))
            )}
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={interjectText}
              onChange={(e) => setInterjectText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !interjectBusy) handleInterject(); }}
              placeholder="Live-Hinweis an den Agent (Enter zum senden)…"
              className="flex-1 px-2 py-1 bg-black/40 border border-gray-700 rounded text-[11px] text-gray-200"
              disabled={interjectBusy}
            />
            <button
              onClick={handleInterject}
              disabled={interjectBusy || !interjectText.trim()}
              className="px-2 py-1 bg-cyan-500/10 text-cyan-400 border border-cyan-500/40 rounded text-[11px] hover:bg-cyan-500/20 disabled:opacity-40"
            >Senden</button>
          </div>
          <button
            onClick={handleStop}
            className="w-full px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/40 rounded text-xs hover:bg-red-500/20"
          >Session stoppen</button>
        </div>
      )}

      {isTerminal && (
        <button
          onClick={handleResume}
          className="w-full px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/40 rounded text-xs hover:bg-emerald-500/20"
        >▶ Resume / Fortsetzen</button>
      )}

      {/* v699 — Sandbox + Live-Preview Panel (nur wenn projectId bekannt) */}
      {projectId && (
        <SandboxPanel
          projectId={projectId}
          sessionId={session.taskId}
          slug={session.goal.slice(0, 20).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}
          compact={compact}
        />
      )}
    </div>
  );
}
