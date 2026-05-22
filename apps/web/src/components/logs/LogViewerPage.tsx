'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { LogEntry, LogFile } from '@/types/api';

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
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0); // 0 = newest (current)
  // v681 — Page-Size + Time-Range + Total für nachhaltiges Log-Browsing
  const [pageSize, setPageSize] = useState(5000); // statt vorher hardcoded 500
  const [offsetFromTail, setOffsetFromTail] = useState(0);
  const [totalLines, setTotalLines] = useState(0);
  const [timeRange, setTimeRange] = useState<'all' | 'today' | '24h' | 'week'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  function rangeToSince(r: typeof timeRange): number | undefined {
    if (r === 'all') return undefined;
    const now = Date.now();
    if (r === '24h') return now - 24 * 3600_000;
    if (r === 'week') return now - 7 * 24 * 3600_000;
    if (r === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    return undefined;
  }

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = rangeToSince(timeRange);
      if (activeTab === 'app') {
        const res = await client.fetchLogs({
          lines: pageSize, level: levelFilter, filter: textFilter || undefined,
          fileIndex: selectedFileIdx, since, offset: offsetFromTail,
        });
        setLogs(res.lines);
        setTotalLines((res as { total?: number }).total ?? res.lines.length);
        if (res.files) setLogFiles(res.files);
      } else {
        const res = await client.fetchAuditLogs(pageSize, selectedFileIdx, { since, offset: offsetFromTail });
        setLogs(res.lines);
        setTotalLines((res as { total?: number }).total ?? res.lines.length);
        if (res.files) setLogFiles(res.files);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, activeTab, levelFilter, textFilter, selectedFileIdx, pageSize, offsetFromTail, timeRange]);

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

        {/* File Selector */}
        {logFiles.length > 1 && (
          <select
            value={selectedFileIdx}
            onChange={e => { setSelectedFileIdx(Number(e.target.value)); setLiveTail(false); }}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-300"
          >
            {logFiles.map((f, i) => {
              const date = new Date(f.modified).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
              const sizeKb = Math.round(f.size / 1024);
              return (
                <option key={i} value={i}>
                  {i === 0 ? `${f.name} (aktuell)` : `${f.name} (${date}, ${sizeKb}KB)`}
                </option>
              );
            })}
          </select>
        )}

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

        {/* Live Tail — only for current file */}
        {activeTab === 'app' && selectedFileIdx === 0 && (
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

        {/* v681 — Time-Range */}
        <select
          value={timeRange}
          onChange={e => { setTimeRange(e.target.value as typeof timeRange); setOffsetFromTail(0); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-300"
          title="Zeitraum-Filter (clientseitig, basiert auf Log-Time-Field)"
        >
          <option value="all">Ganze Datei</option>
          <option value="today">Heute</option>
          <option value="24h">Letzte 24h</option>
          <option value="week">Letzte 7 Tage</option>
        </select>

        {/* v681 — Page Size */}
        <select
          value={pageSize}
          onChange={e => { setPageSize(Number(e.target.value)); setOffsetFromTail(0); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-300"
          title="Zeilen pro Seite"
        >
          <option value="500">500 Zeilen</option>
          <option value="2000">2.000 Zeilen</option>
          <option value="5000">5.000 Zeilen</option>
          <option value="20000">20.000 Zeilen</option>
          <option value="100000">100.000 (alles)</option>
        </select>

        {error && <span className="text-xs text-red-400">{error}</span>}
        {/* v681 — bessere Status-Anzeige: Range + Total */}
        <span className="text-xs text-gray-500 ml-auto" title={`Zeige ${logs.length} Zeilen, ${offsetFromTail > 0 ? `Offset ${offsetFromTail}, ` : ''}gefiltert auf ${totalLines} von der Datei`}>
          {offsetFromTail > 0
            ? `${offsetFromTail + 1}–${offsetFromTail + logs.length} von ${totalLines}`
            : `${logs.length} von ${totalLines}`}
        </span>
      </div>

      {/* v681 — Pagination */}
      {totalLines > pageSize && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-[#1f1f1f] bg-[#0a0a0a]">
          <button
            onClick={() => setOffsetFromTail(o => Math.min(o + pageSize, totalLines - pageSize))}
            disabled={offsetFromTail + pageSize >= totalLines}
            className="px-2 py-0.5 bg-[#141414] border border-[#2a2a2a] rounded hover:border-blue-500/40 disabled:opacity-40 text-gray-300"
          >← Ältere {pageSize}</button>
          <button
            onClick={() => setOffsetFromTail(o => Math.max(0, o - pageSize))}
            disabled={offsetFromTail === 0}
            className="px-2 py-0.5 bg-[#141414] border border-[#2a2a2a] rounded hover:border-blue-500/40 disabled:opacity-40 text-gray-300"
          >Neuere {pageSize} →</button>
          <button
            onClick={() => setOffsetFromTail(0)}
            disabled={offsetFromTail === 0}
            className="px-2 py-0.5 text-gray-500 hover:text-gray-200 disabled:opacity-40"
          >Zum Aktuellen</button>
          <span className="text-gray-600 ml-auto">Aktive Datei: {logFiles[selectedFileIdx]?.name ?? '?'} ({Math.round((logFiles[selectedFileIdx]?.size ?? 0) / 1024)} KB)</span>
        </div>
      )}

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
