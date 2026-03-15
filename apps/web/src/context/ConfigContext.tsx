'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { AlfredClient } from '@/lib/alfred-client';

interface Config {
  apiUrl: string;
  apiToken: string;
}

interface ConfigContextValue {
  config: Config;
  setConfig: (c: Config) => void;
  client: AlfredClient;
}

const defaults: Config = {
  apiUrl: process.env.NEXT_PUBLIC_ALFRED_API_URL ?? 'http://localhost:3420',
  apiToken: '',
};

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<Config>(defaults);
  const [client] = useState(() => new AlfredClient(defaults.apiUrl, defaults.apiToken));

  useEffect(() => {
    try {
      const stored = localStorage.getItem('alfred-config');
      if (stored) {
        const parsed = JSON.parse(stored) as Config;
        setConfigState(parsed);
        client.updateConfig(parsed.apiUrl, parsed.apiToken);
      }
    } catch { /* ignore */ }
  }, [client]);

  const setConfig = (c: Config) => {
    setConfigState(c);
    client.updateConfig(c.apiUrl, c.apiToken);
    localStorage.setItem('alfred-config', JSON.stringify(c));
  };

  return (
    <ConfigContext.Provider value={{ config, setConfig, client }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider');
  return ctx;
}
