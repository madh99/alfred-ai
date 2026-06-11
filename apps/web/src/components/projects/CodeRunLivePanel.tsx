'use client';

/**
 * v869.3 — Live-Output-Panel für asynchrone Open-Items-Code-Läufe.
 *
 * Nutzt die taskId-generische Streaming-Infrastruktur der Project-Agents:
 * der code_agent-Lauf schreibt mit seiner liveTaskId in den outputBuffer,
 * der SSE-Endpoint /api/project-agents/:taskId/output streamt jeden Buffer.
 * Ende wird an der ✅/❌-System-Abschlusszeile erkannt → onEnded (Detail-Reload).
 */
import { useEffect, useRef, useState } from 'react';
import type { AlfredClient } from '@/lib/alfred-client';

interface OutputLine { ts: number; source: string; text: string }

export function CodeRunLivePanel({ client, taskId, onEnded, onClose }: {
  client: AlfredClient;
  taskId: string;
  /** Lauf beendet (✅ oder ❌) — Caller lädt das Projekt-Detail neu. */
  onEnded: (success: boolean) => void;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<'running' | 'success' | 'failed'>('running');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const endedRef = useRef(false);

  useEffect(() => {
    const handleLine = (line: OutputLine) => {
      setLines(prev => [...prev.slice(-499), line]);
      if (!endedRef.current && line.source === 'system') {
        if (line.text.startsWith('✅')) {
          endedRef.current = true; setStatus('success'); onEnded(true);
        } else if (line.text.startsWith('❌')) {
          endedRef.current = true; setStatus('failed'); onEnded(false);
        }
      }
    };
    const es = client.openProjectAgentOutputStream(
      taskId,
      handleLine,
      (history) => { setLines(history.slice(-500)); for (const l of history) handleLine(l); },
    );
    return () => { es.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, taskId]);

  // Autoscroll ans Ende
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="bg-[#0d0d0d] border border-emerald-500/30 rounded-lg p-2 mb-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={
          status === 'running' ? 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse'
          : status === 'success' ? 'w-2 h-2 rounded-full bg-emerald-500'
          : 'w-2 h-2 rounded-full bg-red-500'
        } />
        <span className="text-xs font-semibold text-gray-300">
          {status === 'running' ? 'Code-Agent läuft …'
            : status === 'success' ? 'Code-Agent fertig — Items erledigt markiert'
            : 'Code-Agent fehlgeschlagen — Items wieder geöffnet (mit Notiz)'}
        </span>
        <span className="text-[10px] text-gray-600 font-mono">{taskId.slice(0, 8)}</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 border border-[#2a2a2a] rounded"
        >{status === 'running' ? 'Ausblenden' : 'Schließen'}</button>
      </div>
      <div ref={boxRef} className="bg-black/60 border border-gray-800 rounded p-2 text-[11px] font-mono h-48 overflow-y-auto whitespace-pre-wrap">
        {lines.length === 0 ? (
          <div className="text-gray-600 italic">Warte auf Output…</div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className={l.source === 'stderr' ? 'text-red-300' : l.source === 'system' ? 'text-blue-300' : 'text-gray-300'}
            >{l.text}</div>
          ))
        )}
      </div>
    </div>
  );
}
