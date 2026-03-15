'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DashboardData } from '@/types/api';
import { useConfig } from '@/context/ConfigContext';

export function useDashboard(refreshInterval = 30_000) {
  const { client } = useConfig();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await client.fetchDashboard();
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshInterval);
    return () => clearInterval(timer);
  }, [refresh, refreshInterval]);

  return { data, loading, error, refresh };
}
