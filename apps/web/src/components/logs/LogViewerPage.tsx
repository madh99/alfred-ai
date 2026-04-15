'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { LogEntry } from '@/types/api';

const LEVEL_NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const LEVEL_COLORS: Record<number, string> = {
  10: 'text-gray-500', 20: 'text-gray-400', 30: 'text-green-400',
  40: 'text-yellow-400', 50: 'text-red-400', 60: 'text-red-500 font-bold',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
}

export function LogViewerPage() {
  const { client } = useConfig();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState('info');
  const [textFilter, setTextFilter] = useState('');
  const [activeTab, setActiveTab] = useState<'app' | 'audit'>('app');
  const [liveTail, setLiveTail] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'app') {
        const res = await client.fetchLogs({ lines: 500, level: levelFilter, filter: textFilter || undefined });
        setLogs(res.lines);
      } else {
        const res = await client.fetchAuditLogs(200);
        setLogs(res.lines);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, activeTab, levelFilter, textFilter]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Live tail
  useEffect(() => {
    if (!liveTail || activeTab !== 'app') return;
    cleanupRef.current = client.streamLogs(
      (entry) => setLogs(prev => [...prev.slice(-2000), entry]),
      { level: levelFilter, filter: textFilter || undefined },
    );
    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
  }, [liveTail, activeTab, levelFilter, textFilter, client]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-[#1f1f1f] flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-200">Logs</h1>

        {/* Tabs */}
        <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
          {(['app', 'audit'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setLiveTail(false); }}
              className={clsx(
                'px-3 py-1 text-xs rounded-md transition-colors',
                activeTab === tab ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:text-gray-200',
              )}
            >
              {tab === 'app' ? 'Application' : 'Audit'}
            </button>
          ))}
        </div>

        {/* Level Filter */}
        {activeTab === 'app' && (
          <select
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value)}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value="trace">Trace+</option>
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error+</option>
          </select>
        )}

        {/* Text Filter */}
        <input
          type="text"
          placeholder="Filter (text, component...)"
          value={textFilter}
          onChange={e => setTextFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && fetchLogs()}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-300 w-48"
        />

        <button onClick={fetchLogs} className="text-xs text-blue-400 hover:text-blue-300">
          Laden
        </button>

        {/* Live Tail */}
        {activeTab === 'app' && (
          <button
            onClick={() => setLiveTail(!liveTail)}
            className={clsx(
              'px-3 py-1 text-xs rounded-md transition-colors',
              liveTail ? 'bg-green-500/20 text-green-400' : 'bg-[#1a1a1a] text-gray-400 hover:text-gray-200',
            )}
          >
            {liveTail ? 'Live' : 'Live Tail'}
          </button>
        )}

        {error && <span className="text-xs text-red-400">{error}</span>}
        <span className="text-xs text-gray-500 ml-auto">{logs.length} Eintr.</span>
      </div>

      {/* Log Table */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto font-mono text-xs">
        {loading && logs.length === 0 ? (
          <div className="p-8 text-gray-500">Laden...</div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-[#0a0a0a] z-10">
              <tr className="text-left text-gray-500 border-b border-[#1f1f1f]">
                <th className="px-2 py-1 w-16">Zeit</th>
                <th className="px-2 py-1 w-14">Level</th>
                <th className="px-2 py-1 w-32">Component</th>
                <th className="px-2 py-1">Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <LogRow
                  key={`${log.time}-${i}`}
                  log={log}
                  expanded={expandedIdx === i}
                  onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function LogRow({ log, expanded, onToggle }: { log: LogEntry; expanded: boolean; onToggle: () => void }) {
  const levelName = LEVEL_NAMES[log.level] ?? String(log.level);
  const levelColor = LEVEL_COLORS[log.level] ?? 'text-gray-400';

  // Extract known fields, rest goes into details
  const { level, time, pid, name, msg, version, hostname, component, ...rest } = log;
  const hasDetails = Object.keys(rest).length > 0;

  return (
    <>
      <tr
        onClick={hasDetails ? onToggle : undefined}
        className={clsx(
          'border-b border-[#141414] hover:bg-[#111111] transition-colors',
          hasDetails && 'cursor-pointer',
          log.level >= 50 && 'bg-red-500/5',
          log.level === 40 && 'bg-yellow-500/5',
        )}
      >
        <td className="px-2 py-1 text-gray-500 whitespace-nowrap">
          <span title={new Date(time).toISOString()}>
            {formatDate(time)} {formatTime(time)}
          </span>
        </td>
        <td className={clsx('px-2 py-1 whitespace-nowrap', levelColor)}>{levelName}</td>
        <td className="px-2 py-1 text-gray-500 truncate max-w-[200px]" title={String(component ?? name ?? '')}>
          {String(component ?? name ?? '')}
        </td>
        <td className="px-2 py-1 text-gray-300 truncate max-w-[600px]" title={msg}>
          {msg}
          {hasDetails && <span className="ml-1 text-gray-600">{expanded ? '[-]' : '[+]'}</span>}
        </td>
      </tr>
      {expanded && hasDetails && (
        <tr className="bg-[#0d0d0d]">
          <td colSpan={4} className="px-4 py-2">
            <pre className="text-[10px] text-gray-400 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
              {JSON.stringify(rest, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
