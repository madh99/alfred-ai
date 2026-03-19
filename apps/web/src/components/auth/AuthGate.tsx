'use client';

import { useConfig } from '@/context/ConfigContext';
import { useState, useEffect } from 'react';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { config, user, login } = useConfig();
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Check if auth is required
    const checkAuth = async () => {
      try {
        const res = await fetch(`${config.apiUrl}/api/auth/required`);
        if (res.ok) {
          const data = await res.json();
          setAuthRequired(data.authRequired);
        } else {
          setAuthRequired(false); // Can't reach server, show UI anyway
        }
      } catch {
        setAuthRequired(false);
      }
    };
    if (config.apiUrl) checkAuth();
    else setAuthRequired(false);
  }, [config.apiUrl]);

  // Still loading auth status
  if (authRequired === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
        <div className="text-gray-400">Verbinde...</div>
      </div>
    );
  }

  // Auth not required (no api.token configured) or user is logged in
  if (!authRequired || user) {
    return <>{children}</>;
  }

  // Auth required but no user — show login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    const result = await login(code.trim());
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? 'Login fehlgeschlagen');
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
      <div className="w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-mono font-bold text-blue-500 mb-2">Alfred</h1>
          <p className="text-sm text-gray-500">Self-hosted AI Assistant</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Einmal-Code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code eingeben..."
              className="w-full px-4 py-2 bg-[#111111] border border-[#1f1f1f] rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              autoFocus
              disabled={loading}
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors"
          >
            {loading ? 'Anmelden...' : 'Anmelden'}
          </button>
          <p className="text-xs text-gray-600 text-center mt-4">
            Den Einmal-Code erhältst du vom Admin oder über einen verknüpften Messenger (Telegram, Matrix).
          </p>
        </form>
      </div>
    </div>
  );
}
