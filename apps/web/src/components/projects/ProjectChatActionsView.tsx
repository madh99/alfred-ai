'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ChatActionDto } from '@/lib/alfred-client';

interface Props {
  projectId: string;
}

/**
 * v847 — Project-Chat-Action-Tracking-View.
 *
 * Zeigt alle Chat-getriggerten Skill-Arbeiten (die ihre Spur in
 * `project_chat_actions` haben) für ein Projekt. Pre-v847 war diese Arbeit
 * "unsichtbar" — sie tauchte in keiner Session-Liste auf obwohl sie Cost
 * verursachte, Commits machte und Files änderte.
 *
 * Click auf einen Eintrag öffnet ein Modal mit voller Skill-Trace +
 * Commits + Modified-Files + Full Request/Response Text.
 */
export function ProjectChatActionsView({ projectId }: Props) {
  const { client } = useConfig();
  const [actions, setActions] = useState<ChatActionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<ChatActionDto | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.fetchProjectChatActions(projectId, 50);
      setActions(list);
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    if (expanded && actions.length === 0) load();
  }, [expanded, actions.length, load]);

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5"
        >
          <span>💬</span>
          <span>Chat-Aktionen anzeigen</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>💬</span>
          <span>Chat-Aktionen ({actions.length})</span>
        </h3>
        <button
          onClick={() => setExpanded(false)}
          className="text-[10px] text-gray-500 hover:text-gray-300"
        >
          schließen
        </button>
      </div>
      {loading && <div className="text-[10px] text-gray-500 italic">lade…</div>}
      {!loading && actions.length === 0 && (
        <div className="text-[10px] text-gray-600 italic">Noch keine Chat-Aktionen für dieses Projekt.</div>
      )}
      <div className="space-y-1">
        {actions.map(a => {
          const statusColor =
            a.status === 'running' ? 'border-amber-500/40 bg-amber-500/5' :
            a.status === 'error' ? 'border-red-500/40 bg-red-500/5' :
            'border-[#1f1f1f] bg-[#0a0a0a]';
          const statusBadge =
            a.status === 'running' ? '⏳' :
            a.status === 'error' ? '✗' : '✓';
          const dur = a.endedAt
            ? Math.max(0, new Date(a.endedAt).getTime() - new Date(a.startedAt).getTime())
            : a.totalDurationMs;
          const durSec = (dur / 1000).toFixed(1);
          const when = new Date(a.startedAt).toLocaleString('de-DE');
          return (
            <button
              key={a.id}
              onClick={() => setSelected(a)}
              className={`block w-full text-left ${statusColor} border rounded px-2 py-1.5 text-[11px] hover:bg-emerald-500/10 transition-colors`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[9px] font-mono">{statusBadge}</span>
                <span className="text-gray-200 flex-1 truncate">{a.requestText.slice(0, 80)}</span>
                <span className="text-[9px] text-gray-500">{a.totalSkillCount} skill{a.totalSkillCount === 1 ? '' : 's'}</span>
                <span className="text-[9px] text-gray-500">{durSec}s</span>
                {a.totalCostUsd > 0 && (
                  <span className="text-[9px] text-amber-400/80">${a.totalCostUsd.toFixed(4)}</span>
                )}
                <span className="text-[9px] text-gray-600">{when}</span>
              </div>
              {(a.commitShas.length > 0 || a.modifiedFiles.length > 0) && (
                <div className="text-[9px] text-gray-500 mt-0.5 truncate">
                  {a.commitShas.length > 0 && <span>📦 {a.commitShas.length} commit{a.commitShas.length === 1 ? '' : 's'}</span>}
                  {a.modifiedFiles.length > 0 && (
                    <span className="ml-2">📄 {a.modifiedFiles.length} file{a.modifiedFiles.length === 1 ? '' : 's'}</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {selected && <ChatActionDetailModal action={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ChatActionDetailModal({ action, onClose }: { action: ChatActionDto; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#0a0a0a] border border-[#333] rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">Chat-Aktion Detail</h2>
            <div className="text-[10px] text-gray-500 font-mono">{action.id}</div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3 text-[10px]">
          <div className="text-gray-500">Start: <span className="text-gray-300">{new Date(action.startedAt).toLocaleString('de-DE')}</span></div>
          <div className="text-gray-500">Ende: <span className="text-gray-300">{action.endedAt ? new Date(action.endedAt).toLocaleString('de-DE') : '—'}</span></div>
          <div className="text-gray-500">Status: <span className="text-gray-300">{action.status}</span></div>
          <div className="text-gray-500">Dauer: <span className="text-gray-300">{(action.totalDurationMs / 1000).toFixed(1)}s</span></div>
          <div className="text-gray-500">Cost: <span className="text-amber-400">${action.totalCostUsd.toFixed(4)}</span></div>
          <div className="text-gray-500">Skill-Calls: <span className="text-gray-300">{action.totalSkillCount}</span></div>
        </div>

        <div className="mb-3">
          <h3 className="text-[11px] font-semibold text-gray-300 mb-1">Request</h3>
          <pre className="bg-black/50 border border-[#222] rounded px-2 py-1 text-[10px] text-gray-300 whitespace-pre-wrap max-h-40 overflow-y-auto">{action.requestText}</pre>
        </div>

        {action.responseText && (
          <div className="mb-3">
            <h3 className="text-[11px] font-semibold text-gray-300 mb-1">Antwort</h3>
            <pre className="bg-black/50 border border-[#222] rounded px-2 py-1 text-[10px] text-gray-300 whitespace-pre-wrap max-h-60 overflow-y-auto">{action.responseText}</pre>
          </div>
        )}

        {action.skillsCalled.length > 0 && (
          <div className="mb-3">
            <h3 className="text-[11px] font-semibold text-gray-300 mb-1">Skill-Calls ({action.skillsCalled.length})</h3>
            <div className="space-y-0.5">
              {action.skillsCalled.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px] bg-black/30 border border-[#1a1a1a] rounded px-2 py-0.5">
                  <span>{s.success ? '✓' : '✗'}</span>
                  <span className="text-blue-300 font-medium">{s.skill}</span>
                  {s.action && <span className="text-gray-400">.{s.action}</span>}
                  <span className="text-gray-500 ml-auto">{(s.durationMs / 1000).toFixed(2)}s</span>
                  {s.costUsd != null && s.costUsd > 0 && <span className="text-amber-400/80">${s.costUsd.toFixed(4)}</span>}
                  {s.error && <span className="text-red-400 truncate max-w-[40%]">{s.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {action.commitShas.length > 0 && (
          <div className="mb-3">
            <h3 className="text-[11px] font-semibold text-gray-300 mb-1">Commits ({action.commitShas.length})</h3>
            <div className="font-mono text-[10px] text-emerald-300 space-y-0.5">
              {action.commitShas.map((sha) => (<div key={sha}>📦 {sha}</div>))}
            </div>
          </div>
        )}

        {action.modifiedFiles.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold text-gray-300 mb-1">Modified Files ({action.modifiedFiles.length})</h3>
            <div className="font-mono text-[10px] text-gray-400 space-y-0.5">
              {action.modifiedFiles.map((f) => (<div key={f}>📄 {f}</div>))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
