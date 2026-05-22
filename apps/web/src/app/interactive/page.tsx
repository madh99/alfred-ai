'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxItem } from '@/lib/alfred-client';

const STATUS_COLOR: Record<string, string> = {
  creating: 'text-amber-400 bg-amber-500/10 border-amber-500/40',
  running: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/40',
  paused: 'text-blue-400 bg-blue-500/10 border-blue-500/40',
  failed: 'text-red-400 bg-red-500/10 border-red-500/40',
  discarded: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  cleaned: 'text-gray-500 bg-gray-500/10 border-gray-500/40',
  merging: 'text-purple-400 bg-purple-500/10 border-purple-500/40',
};

/**
 * v700 — Interactive-Chat-Mode Page (Route: /interactive?sandboxId=...).
 *
 * Layout: Chat links (40%) + Preview rechts (60%). Fokus-View für eine Sandbox.
 * Der Chat-Input wird in v701 zur eigentlichen Agent-Loop ausgebaut.
 *
 * Query-Param statt dynamic-route weil Next.js mit output:export keine
 * dynamicParams unterstützt.
 */
export default function InteractivePage() {
  const search = useSearchParams();
  const sandboxId = search?.get('sandboxId') ?? '';
  const { client } = useConfig();
  const [sandbox, setSandbox] = useState<SandboxItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'agent'; text: string; ts: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || !sandboxId) return;
    try {
      const sb = await client.getSandbox(sandboxId);
      setSandbox(sb);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, sandboxId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!sandbox) return;
    if (sandbox.status !== 'creating' && sandbox.status !== 'merging') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [sandbox?.status, load]);

  const previewUrl = useMemo(() => {
    if (!sandbox || sandbox.status !== 'running' || !client) return null;
    return client.buildSandboxPreviewUrl(sandbox.id);
  }, [sandbox, client]);

  async function handleSendMessage() {
    const text = chatInput.trim();
    if (!text || !sandbox) return;
    setChatHistory(prev => [...prev, { role: 'user', text, ts: Date.now() }]);
    setChatInput('');
    setBusy('send');
    // v700: Placeholder-Antwort. Agent-Execution-Loop (Spawn von Project-Agent-Task
    // mit cwd=worktree pro Nachricht) wird in v701 implementiert.
    setTimeout(() => {
      setChatHistory(prev => [...prev, {
        role: 'agent',
        text: `🚧 Interactive-Agent-Loop ist in v700 als Skelett angelegt — der Agent läuft noch nicht automatisch pro Nachricht. Workaround: Nutze den Project-Chat mit derselben Session, dort kannst du Project-Agent-Tasks starten die im Sandbox-Worktree (\`${sandbox.worktreePath}\`) laufen. Live-Preview rechts updated via HMR.`,
        ts: Date.now(),
      }]);
      setBusy(null);
    }, 400);
  }

  async function handleDiscard() {
    if (!client || !sandbox) return;
    if (!confirm('Sandbox verwerfen? Alle Änderungen gehen verloren wenn nicht gemerged.')) return;
    setBusy('discard');
    try { await client.discardSandbox(sandbox.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleMerge() {
    if (!client || !sandbox) return;
    const strategy = confirm('Mit PR mergen?\n\nOK = Branch pushen + PR auf Forge\nAbbrechen = Direct-Push in main') ? 'pr' : 'direct';
    setBusy('merge');
    try {
      const r = await client.mergeSandbox(sandbox.id, { strategy: strategy as 'direct' | 'pr' });
      if (r.ok) {
        if (r.prUrl) window.open(r.prUrl, '_blank');
        await load();
      } else { setError(`Merge fehlgeschlagen: ${r.reason ?? 'unknown'}`); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  if (!sandboxId) return (
    <div className="min-h-screen bg-[#0a0a0a] text-amber-400 p-6 text-sm">
      Kein sandboxId in der URL. Erwartet: <code>/interactive?sandboxId=…</code>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-[#0a0a0a] text-red-400 p-6">
      <h1 className="text-xl">Fehler</h1>
      <p className="text-sm">{error}</p>
    </div>
  );

  if (!sandbox) return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-500 p-6 text-sm">Lade Sandbox …</div>
  );

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-gray-200">
      <header className="flex items-center justify-between border-b border-[#1a1a1a] px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-gray-200">💬 Interactive · {sandbox.branchName}</span>
          <span className={`px-2 py-0.5 rounded border ${STATUS_COLOR[sandbox.status] ?? 'text-gray-400 border-gray-500/40'}`}>{sandbox.status}</span>
          <span className="text-gray-500">type: {sandbox.projectType ?? '—'} · port {sandbox.hostPort ?? '—'}</span>
        </div>
        <div className="flex gap-2">
          {sandbox.status === 'running' && (
            <>
              <button onClick={handleMerge} disabled={busy !== null} className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] disabled:opacity-50">✅ Merge</button>
              <button onClick={handleDiscard} disabled={busy !== null} className="px-2 py-1 border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded text-[11px] disabled:opacity-50">✕ Discard</button>
            </>
          )}
          <button onClick={() => window.close()} className="px-2 py-1 border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded text-[11px]">Schließen</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-[40%] flex flex-col border-r border-[#1a1a1a]">
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatHistory.length === 0 && (
              <div className="text-xs text-gray-500 italic">
                Beschreibe was die Sandbox bauen/ändern soll. Jede Nachricht wird vom Agent im Worktree umgesetzt — die Live-Preview rechts zeigt das Ergebnis sofort via HMR.
                <div className="mt-3 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-[11px]">
                  🚧 Hinweis: Die automatische Agent-Loop pro Nachricht ist in v700 als Skelett angelegt — kommt in v701 voll. Bis dahin: nutze den Project-Chat, Project-Agent-Tasks laufen im Worktree.
                </div>
              </div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} className={`text-xs rounded p-2 ${m.role === 'user' ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-[#111] border border-[#1f1f1f]'}`}>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{m.role === 'user' ? 'Du' : 'Agent'}</div>
                <div className="whitespace-pre-wrap text-gray-200">{m.text}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-[#1a1a1a] p-2 flex gap-2">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
              placeholder="Was soll der Agent ändern? (Enter = senden, Shift+Enter = Zeilenumbruch)"
              rows={3}
              className="flex-1 bg-[#0d0d0d] border border-[#2a2a2a] rounded text-xs text-gray-200 p-2 resize-none focus:outline-none focus:border-blue-500"
              disabled={busy !== null}
            />
            <button
              onClick={handleSendMessage}
              disabled={busy !== null || !chatInput.trim()}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-xs"
            >Senden</button>
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          {previewUrl ? (
            <iframe
              src={previewUrl}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              className="flex-1 bg-white border-0"
              title={`Sandbox Preview ${sandbox.id.slice(0, 8)}`}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              {sandbox.status === 'creating' && '⏳ Container startet…'}
              {sandbox.status === 'paused' && '⏸ Sandbox pausiert — Resume im Project-Chat'}
              {sandbox.status === 'failed' && `⚠ Failed: ${sandbox.statusReason ?? 'unknown'}`}
              {(sandbox.status === 'discarded' || sandbox.status === 'cleaned') && '✕ Sandbox entfernt'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
