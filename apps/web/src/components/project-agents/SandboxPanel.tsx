'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxItem, SandboxStatusResponse } from '@/lib/alfred-client';

interface Props {
  projectId: string;
  sessionId: string;
  /** Default-Mode aus der Session (z.B. aus mode-Spalte). */
  defaultMode?: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  /** Slug für Branch-Naming (z.B. erste Wörter der goal). */
  slug?: string;
  /** Wenn true: minimiertes Layout (Embed). */
  compact?: boolean;
}

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
 * v699 — SandboxPanel
 *
 * Zeigt für eine Session den Sandbox-Status + Preview-iframe + Aktionen.
 * Bei fehlender Sandbox: „Create"-Button mit Mode-Wahl.
 * Bei laufender Sandbox: iframe + Pause/Resume/Discard/Merge-Buttons.
 */
export function SandboxPanel({ projectId, sessionId, defaultMode = 'sandbox-preview', slug, compact }: Props) {
  const { client } = useConfig();
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [sandbox, setSandbox] = useState<SandboxItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffText, setDiffText] = useState<string>('');
  const [mode, setMode] = useState<'sandbox' | 'sandbox-preview' | 'interactive-chat'>(defaultMode);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [s, list] = await Promise.all([
        client.fetchSandboxStatus(),
        client.listSandboxes({ sessionId }),
      ]);
      setStatus(s);
      setSandbox(list[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, sessionId]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh wenn creating/merging (UI-Status sync mit Backend)
  useEffect(() => {
    if (!sandbox) return;
    if (sandbox.status !== 'creating' && sandbox.status !== 'merging') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [sandbox?.status, load]);

  async function handleCreate() {
    if (!client) return;
    setBusy('create'); setError(null);
    try {
      const r = await client.createSandbox({ projectId, sessionId, mode, slug });
      setSandbox(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function handlePause() {
    if (!client || !sandbox) return;
    setBusy('pause'); setError(null);
    try { await client.pauseSandbox(sandbox.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleResume() {
    if (!client || !sandbox) return;
    setBusy('resume'); setError(null);
    try { await client.resumeSandbox(sandbox.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleDiscard() {
    if (!client || !sandbox) return;
    if (!confirm(`Sandbox endgültig verwerfen?\n\nWorktree + Branch (${sandbox.branchName}) werden gelöscht. Alle Änderungen gehen verloren wenn nicht gemerged.`)) return;
    setBusy('discard'); setError(null);
    try { await client.discardSandbox(sandbox.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleMerge() {
    if (!client || !sandbox) return;
    const strategy = confirm('Mit PR mergen?\n\nOK = Branch pushen + PR/MR auf Forge erstellen\nAbbrechen = Direct-Push in main') ? 'pr' : 'direct';
    setBusy('merge'); setError(null);
    try {
      const r = await client.mergeSandbox(sandbox.id, { strategy: strategy as 'direct' | 'pr' });
      if (r.ok) {
        if (r.prUrl) window.open(r.prUrl, '_blank');
        await load();
      } else {
        setError(`Merge fehlgeschlagen: ${r.reason ?? 'unknown'}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function handleShowDiff() {
    if (!client || !sandbox) return;
    if (showDiff) { setShowDiff(false); return; }
    try {
      const text = await client.fetchSandboxDiff(sandbox.id);
      setDiffText(text);
      setShowDiff(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const previewUrl = useMemo(() => {
    if (!sandbox || sandbox.status !== 'running' || !client) return null;
    return client.buildSandboxPreviewUrl(sandbox.id);
  }, [sandbox, client]);

  if (!client) return null;

  // Feature nicht verfügbar
  if (status && !status.available) {
    return (
      <div className="border border-[#1f1f1f] bg-[#0a0a0a] rounded p-4 text-sm text-gray-500">
        <div className="font-semibold text-gray-300 mb-1">📦 Sandbox & Live-Preview</div>
        <div className="text-xs">
          {status.enabled === false ? 'Feature deaktiviert. ' : 'Feature nicht verfügbar. '}
          {status.dockerAvailable === false && 'Docker nicht erreichbar. '}
          {status.worktreeBaseWritable === false && 'Worktree-Pfad nicht beschreibbar. '}
          {status.reason && `(${status.reason})`}
        </div>
      </div>
    );
  }

  return (
    <div className={`border border-[#1f1f1f] bg-[#0a0a0a] rounded ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-gray-200 text-sm">📦 Sandbox & Live-Preview</div>
        {sandbox && (
          <span className={`text-[10px] px-2 py-0.5 rounded border ${STATUS_COLOR[sandbox.status] ?? 'text-gray-400 border-gray-500/40 bg-gray-500/10'}`}>
            {sandbox.status}{sandbox.statusReason ? ` · ${sandbox.statusReason}` : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">{error}</div>
      )}

      {!sandbox && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500">Diese Session läuft im classic-Modus. Du kannst eine Sandbox + Live-Preview parallel anlegen.</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
            >
              <option value="sandbox">Sandbox (Worktree-Isolation, kein Preview)</option>
              <option value="sandbox-preview">Sandbox + Preview (Dev-Server + iframe)</option>
              <option value="interactive-chat">Interactive Chat (dialogisch + Preview)</option>
            </select>
            <button
              onClick={handleCreate}
              disabled={busy === 'create'}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
            >{busy === 'create' ? 'Erstelle …' : '+ Sandbox erstellen'}</button>
          </div>
          <div className="text-[10px] text-gray-600">Erstellung dauert beim ersten Mal 1-3 min (Image-Build), danach &lt;30s.</div>
        </div>
      )}

      {sandbox && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-[10px] text-gray-500">Branch</div>
              <div className="font-mono text-gray-300 break-all">{sandbox.branchName}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">Project-Type</div>
              <div className="text-gray-300">{sandbox.projectType ?? '—'}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">Host-Port</div>
              <div className="font-mono text-gray-300">{sandbox.hostPort ?? '—'}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">Container</div>
              <div className="font-mono text-gray-300 text-[10px]">{sandbox.containerId?.slice(0, 12) ?? '—'}</div>
            </div>
          </div>

          {previewUrl && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-gray-500">
                <span>📺 Live-Preview</span>
                <div className="flex gap-2">
                  <a
                    href={`/interactive?sandboxId=${sandbox.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300"
                  >💬 Interactive-Mode</a>
                  <button
                    onClick={() => window.open(previewUrl, '_blank')}
                    className="text-blue-400 hover:text-blue-300"
                  >🌐 Neuer Tab</button>
                  <button
                    onClick={() => {
                      const iframe = document.getElementById(`sandbox-iframe-${sandbox.id}`) as HTMLIFrameElement | null;
                      if (iframe) iframe.src = iframe.src;
                    }}
                    className="text-blue-400 hover:text-blue-300"
                  >🔄 Reload</button>
                </div>
              </div>
              <iframe
                id={`sandbox-iframe-${sandbox.id}`}
                src={previewUrl}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                className="w-full bg-white rounded border border-[#1f1f1f]"
                style={{ height: compact ? 400 : 600 }}
                title={`Sandbox Preview ${sandbox.id.slice(0, 8)}`}
              />
            </div>
          )}

          {sandbox.status === 'creating' && (
            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              ⏳ Container startet … (pnpm install + dev-server, kann 1-3 min dauern beim ersten Mal)
            </div>
          )}

          {sandbox.status === 'failed' && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
              ⚠ Failed: {sandbox.statusReason ?? 'unknown'}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1 border-t border-[#1a1a1a]">
            {sandbox.status === 'running' && (
              <button onClick={handlePause} disabled={busy !== null} className="px-2 py-1 text-xs border border-blue-500/40 text-blue-400 hover:bg-blue-500/15 rounded disabled:opacity-50">⏸ Pause</button>
            )}
            {sandbox.status === 'paused' && (
              <button onClick={handleResume} disabled={busy !== null} className="px-2 py-1 text-xs border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15 rounded disabled:opacity-50">▶ Resume</button>
            )}
            {(sandbox.status === 'running' || sandbox.status === 'paused') && (
              <>
                <button onClick={handleShowDiff} className="px-2 py-1 text-xs border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded">🔀 Diff</button>
                <button onClick={handleMerge} disabled={busy !== null} className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✅ Merge (v700)</button>
                <button onClick={handleDiscard} disabled={busy !== null} className="px-2 py-1 text-xs border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded disabled:opacity-50">✕ Discard</button>
              </>
            )}
            {(sandbox.status === 'failed' || sandbox.status === 'discarded' || sandbox.status === 'cleaned') && (
              <button onClick={handleDiscard} disabled={busy !== null} className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded disabled:opacity-50">Aufräumen</button>
            )}
          </div>

          {showDiff && (
            <pre className="bg-[#000] border border-[#1a1a1a] rounded p-2 text-[10px] text-gray-300 overflow-x-auto max-h-64 whitespace-pre">
              {diffText || '(no changes)'}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
