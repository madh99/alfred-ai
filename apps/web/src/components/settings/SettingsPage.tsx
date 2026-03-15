'use client';

import { useState, useEffect } from 'react';
import { useConfig } from '@/context/ConfigContext';

export function SettingsPage() {
  const { config, setConfig, client } = useConfig();
  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiToken, setApiToken] = useState(config.apiToken);
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setApiUrl(config.apiUrl);
    setApiToken(config.apiToken);
  }, [config]);

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
    </div>
  );
}
