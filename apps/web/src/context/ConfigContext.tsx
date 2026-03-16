'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { AlfredClient } from '@/lib/alfred-client';

interface Config {
  apiUrl: string;
  apiToken: string;
}

interface AuthUser {
  userId: string;
  username: string;
  role: string;
  token: string;
}

interface ConfigContextValue {
  config: Config;
  setConfig: (c: Config) => void;
  client: AlfredClient;
  user: AuthUser | null;
  login: (code: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const defaults: Config = {
  apiUrl: process.env.NEXT_PUBLIC_ALFRED_API_URL ?? '',
  apiToken: '',
};

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<Config>(defaults);
  const [client] = useState(() => new AlfredClient(defaults.apiUrl, defaults.apiToken));
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('alfred-config');
      if (stored) {
        const parsed = JSON.parse(stored) as Config;
        setConfigState(parsed);
        client.updateConfig(parsed.apiUrl, parsed.apiToken);
      }
      const storedUser = localStorage.getItem('alfred-user');
      if (storedUser) {
        const parsed = JSON.parse(storedUser) as AuthUser;
        setUser(parsed);
        // Set the user token as the API token
        client.updateConfig(config.apiUrl, parsed.token);
      }
    } catch { /* ignore */ }
  }, [client, config.apiUrl]);

  const setConfig = (c: Config) => {
    setConfigState(c);
    client.updateConfig(c.apiUrl, c.apiToken);
    localStorage.setItem('alfred-config', JSON.stringify(c));
  };

  const login = useCallback(async (code: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`${config.apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.success && data.token) {
        const authUser: AuthUser = { userId: data.userId, username: data.username, role: data.role, token: data.token };
        setUser(authUser);
        localStorage.setItem('alfred-user', JSON.stringify(authUser));
        client.updateConfig(config.apiUrl, data.token);
        return { success: true };
      }
      return { success: false, error: data.error ?? 'Login fehlgeschlagen' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }, [config.apiUrl, client]);

  const logout = useCallback(() => {
    setUser(null);
    localStorage.removeItem('alfred-user');
    client.updateConfig(config.apiUrl, '');
  }, [config.apiUrl, client]);

  return (
    <ConfigContext.Provider value={{ config, setConfig, client, user, login, logout }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider');
  return ctx;
}
