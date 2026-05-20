'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { PendingConfirmationItem, ReminderListItem } from '@/lib/alfred-client';

interface Props {
  visible: boolean;
  onClose: () => void;
}

function relativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'überfällig';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `in ${sec}s`;
  if (sec < 3600) return `in ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h`;
  return `in ${Math.floor(sec / 86400)}d`;
}

function PlatformBadge({ platform }: { platform: string }) {
  const icons: Record<string, string> = {
    telegram: '✈️', matrix: '🔷', api: '🌐', discord: '🎮', whatsapp: '💚', signal: '🔵',
  };
  return (
    <span className="text-[10px] text-gray-500 flex items-center gap-1">
      <span>{icons[platform] ?? '💬'}</span>
      <span className="font-mono">{platform}</span>
    </span>
  );
}

export function ChatSidePanel({ visible, onClose }: Props) {
  const { client } = useConfig();
  const [confirmations, setConfirmations] = useState<PendingConfirmationItem[]>([]);
  const [reminders, setReminders] = useState<ReminderListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [conf, rem] = await Promise.all([
        client.fetchPendingConfirmations().catch(() => []),
        client.fetchPendingReminders().catch(() => []),
      ]);
      setConfirmations(conf);
      setReminders(rem.sort((a, b) => new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime()).slice(0, 15));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client]);

  // Auto-refresh every 30s while panel is open
  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [visible, load]);

  async function decide(id: string, decision: 'approve' | 'reject') {
    if (!client) return;
    setBusy(id); setError(null);
    try {
      const r = await client.decideConfirmation(id, decision);
      if (!r.ok) {
        setError(`Aktion fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
      }
      await load();
    } finally { setBusy(null); }
  }

  if (!visible) return null;

  return (
    <aside className="w-80 bg-[#0d0d0d] border-l border-[#1f1f1f] flex flex-col overflow-hidden">
      <header className="px-4 py-3 border-b border-[#1f1f1f] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <span>📋</span>
          <span>Side-Panel</span>
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={load}
            disabled={loading}
            title="Neu laden"
            className="text-[11px] text-gray-500 hover:text-blue-400 px-2 py-1 rounded border border-[#1f1f1f]"
          >↻</button>
          <button
            onClick={onClose}
            title="Panel schließen"
            className="text-[11px] text-gray-500 hover:text-red-400 px-2 py-1 rounded border border-[#1f1f1f]"
          >✕</button>
        </div>
      </header>

      {error && (
        <div className="bg-red-500/10 text-red-400 text-[11px] px-3 py-2 border-b border-red-500/30">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto">
        <section className="px-4 py-3 border-b border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center justify-between">
            <span>Offene Bestätigungen</span>
            <span className="font-mono">{confirmations.length}</span>
          </div>
          {confirmations.length === 0 && !loading && (
            <div className="text-[11px] text-gray-600 italic">Keine offenen Aktionen.</div>
          )}
          {confirmations.map(c => (
            <div key={c.id} className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 mb-2">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="font-mono text-amber-400 uppercase">{c.skillName}</span>
                <PlatformBadge platform={c.platform} />
              </div>
              <div className="text-xs text-gray-200 mb-2 whitespace-pre-wrap break-words">{c.description}</div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-500">
                  läuft {relativeFuture(c.expiresAt)} ab
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => decide(c.id, 'reject')}
                    disabled={busy === c.id}
                    className="text-[11px] px-2 py-1 rounded bg-red-500/15 border border-red-500/40 text-red-300 hover:bg-red-500/30 disabled:opacity-40"
                  >✕ Ablehnen</button>
                  <button
                    onClick={() => decide(c.id, 'approve')}
                    disabled={busy === c.id}
                    className="text-[11px] px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40"
                  >✓ Freigeben</button>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="px-4 py-3 border-b border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center justify-between">
            <span>Anstehende Reminders</span>
            <span className="font-mono">{reminders.length}</span>
          </div>
          {reminders.length === 0 && !loading && (
            <div className="text-[11px] text-gray-600 italic">Keine Reminder geplant.</div>
          )}
          {reminders.map(r => (
            <div key={r.id} className="border border-[#2a2a2a] rounded-lg p-2 mb-1.5">
              <div className="flex items-center justify-between text-[10px] mb-1 text-gray-500">
                <span>{relativeFuture(r.triggerAt)}</span>
                <PlatformBadge platform={r.platform} />
              </div>
              <div className="text-xs text-gray-200 line-clamp-2 break-words">{r.message}</div>
              <div className="text-[10px] text-gray-600 mt-1 font-mono">
                {new Date(r.triggerAt).toLocaleString('de-AT')}
              </div>
            </div>
          ))}
        </section>

        <section className="px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Schnellzugriff</div>
          <div className="grid grid-cols-2 gap-1.5">
            <a href="/alfred/history/" className="text-[11px] px-2 py-1.5 rounded border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] text-center">📜 History</a>
            <a href="/alfred/knowledge/" className="text-[11px] px-2 py-1.5 rounded border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] text-center">🧠 Knowledge</a>
            <a href="/alfred/memories/" className="text-[11px] px-2 py-1.5 rounded border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] text-center">📝 Memories</a>
            <a href="/alfred/runbooks/" className="text-[11px] px-2 py-1.5 rounded border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] text-center">📖 Runbooks</a>
          </div>
        </section>
      </div>
    </aside>
  );
}
