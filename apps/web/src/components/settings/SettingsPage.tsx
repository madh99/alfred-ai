'use client';

import { useState, useEffect } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { SandboxStatusResponse } from '@/lib/alfred-client';

export function SettingsPage() {
  const { config, setConfig, client } = useConfig();
  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiToken, setApiToken] = useState(config.apiToken);
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [saved, setSaved] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusResponse | null>(null);

  useEffect(() => {
    setApiUrl(config.apiUrl);
    setApiToken(config.apiToken);
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await client.fetchSandboxStatus();
        if (!cancelled) setSandboxStatus(r);
      } catch { /* ignore — feature optional */ }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const handleSave = () => {
    setConfig({ apiUrl, apiToken });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    setStatus('testing');
    try {
      await client.fetchHealth();
      setStatus('ok');
    } catch {
      setStatus('error');
    }
    setTimeout(() => setStatus('idle'), 3000);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-200 mb-6">Einstellungen</h1>

      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 space-y-5">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Alfred API URL</label>
          <input
            type="text"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="http://localhost:3420"
            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">API Token</label>
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Optional — Bearer Token"
            className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
          >
            {saved ? 'Gespeichert!' : 'Speichern'}
          </button>
          <button
            onClick={handleTest}
            disabled={status === 'testing'}
            className="bg-[#1a1a1a] border border-[#2a2a2a] hover:bg-[#222] text-gray-300 rounded-lg px-5 py-2.5 text-sm transition-colors disabled:opacity-50"
          >
            {status === 'testing' ? 'Teste...' : status === 'ok' ? 'Verbunden!' : status === 'error' ? 'Fehler!' : 'Verbindung testen'}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-600 mt-4">
        Konfiguration wird in deinem Browser (localStorage) gespeichert. Token wird nie an Dritte gesendet.
      </p>

      {/* v699 — Project-Agent Sandbox Status */}
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 mt-6">
        <h2 className="text-lg font-semibold text-gray-200 mb-3">📦 Project-Agent Sandbox</h2>
        {!sandboxStatus ? (
          <div className="text-xs text-gray-500">Status wird geladen …</div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Feature aktiviert</span>
              <span className={sandboxStatus.enabled ? 'text-emerald-400' : 'text-gray-500'}>{sandboxStatus.enabled ? '✓ ja' : '✕ nein'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Verfügbar</span>
              <span className={sandboxStatus.available ? 'text-emerald-400' : 'text-red-400'}>{sandboxStatus.available ? '✓ einsatzbereit' : '✕ nicht verfügbar'}</span>
            </div>
            {sandboxStatus.dockerAvailable !== undefined && (
              <div className="flex justify-between">
                <span className="text-gray-500">Docker</span>
                <span className={sandboxStatus.dockerAvailable ? 'text-emerald-400' : 'text-red-400'}>{sandboxStatus.dockerAvailable ? '✓ erreichbar' : '✕ nicht erreichbar'}</span>
              </div>
            )}
            {sandboxStatus.worktreeBaseWritable !== undefined && (
              <div className="flex justify-between">
                <span className="text-gray-500">Worktree-Pfad beschreibbar</span>
                <span className={sandboxStatus.worktreeBaseWritable ? 'text-emerald-400' : 'text-red-400'}>{sandboxStatus.worktreeBaseWritable ? '✓ ja' : '✕ nein'}</span>
              </div>
            )}
            {sandboxStatus.defaultMode && (
              <div className="flex justify-between">
                <span className="text-gray-500">Default-Modus</span>
                <span className="text-gray-300 font-mono text-xs">{sandboxStatus.defaultMode}</span>
              </div>
            )}
            {sandboxStatus.defaultMergeStrategy && (
              <div className="flex justify-between">
                <span className="text-gray-500">Default-Merge-Strategie</span>
                <span className="text-gray-300 font-mono text-xs">{sandboxStatus.defaultMergeStrategy}</span>
              </div>
            )}
            {sandboxStatus.healthCheckedAt && (
              <div className="flex justify-between">
                <span className="text-gray-500">Health-Check</span>
                <span className="text-gray-500 text-xs">{new Date(sandboxStatus.healthCheckedAt).toLocaleString('de-AT')}</span>
              </div>
            )}
            {sandboxStatus.reason && (
              <div className="mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-400">{sandboxStatus.reason}</div>
            )}
            <div className="mt-3 pt-3 border-t border-[#1f1f1f] text-xs text-gray-500">
              Aktivierung via ENV: <code className="text-gray-400">ALFRED_SANDBOX_ENABLED=true</code> + <code className="text-gray-400">ALFRED_SANDBOX_WORKTREE_BASE_PATH=...</code>.
              Bei HA-Cluster: Worktree-Pfad auf NFS-Mount legen.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
