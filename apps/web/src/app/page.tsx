'use client';

import { useConfig } from '@/context/ConfigContext';
import { ChatPage } from '@/components/chat/ChatPage';
import { useState } from 'react';

function LoginPage() {
  const { login } = useConfig();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    const result = await login(code.trim());
    setLoading(false);
    if (!result.success) setError(result.error ?? 'Login fehlgeschlagen');
  };

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-center mb-8">
        <p className="text-4xl font-mono font-bold text-blue-500 mb-2">Alfred</p>
        <p className="text-sm text-gray-500">Self-hosted AI Assistant</p>
      </div>
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-80">
        <p className="text-sm text-gray-400 mb-4">Invite-Code eingeben um dich zu verbinden:</p>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder="6-stelliger Code"
          maxLength={6}
          className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-4 py-3 text-center text-xl font-mono text-gray-200 tracking-widest focus:outline-none focus:border-blue-500 mb-3"
        />
        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        <button
          onClick={handleLogin}
          disabled={loading || code.length < 6}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          {loading ? 'Verbinde...' : 'Verbinden'}
        </button>
        <p className="text-xs text-gray-600 mt-4 text-center">
          Code erhältst du vom Admin per Telegram/Matrix.
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const { user } = useConfig();

  if (!user) return <LoginPage />;
  return <ChatPage />;
}
