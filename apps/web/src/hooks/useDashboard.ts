'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DashboardData } from '@/types/api';
import { useConfig } from '@/context/ConfigContext';

export type DashboardRange = 'today' | 'week' | 'month' | 'year' | 'all';
export type DashboardGranularity = 'day' | 'hour';

export function useDashboard(
  refreshInterval = 30_000,
  range: DashboardRange = 'week',
  granularity: DashboardGranularity = 'day',
  hourlyDate?: string,
) {
  const { client } = useConfig();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await client.fetchDashboard(range, granularity, hourlyDate);
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, range, granularity, hourlyDate]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshInterval);
    return () => clearInterval(timer);
  }, [refresh, refreshInterval]);

  return { data, loading, error, refresh };
}
