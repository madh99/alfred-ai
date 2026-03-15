'use client';

import { useDashboard } from '@/hooks/useDashboard';
import clsx from 'clsx';

export function DashboardPage() {
  const { data, loading, error, refresh } = useDashboard();

  if (loading) return <div className="p-8 text-gray-400">Laden...</div>;
  if (error) return <div className="p-8 text-red-400">Fehler: {error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold text-gray-200">Dashboard</h1>
        <button onClick={refresh} className="text-sm text-blue-400 hover:text-blue-300">Aktualisieren</button>
      </div>

      {/* Watches */}
      <section>
        <h2 className="text-lg font-medium text-gray-300 mb-3">Aktive Watches ({data.watches.length})</h2>
        {data.watches.length === 0 ? (
          <p className="text-gray-500 text-sm">Keine aktiven Watches.</p>
        ) : (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {data.watches.map((w) => (
              <div key={w.id} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-medium text-gray-200 text-sm">{w.name}</h3>
                  <span className={clsx('text-xs px-2 py-0.5 rounded-full', w.enabled ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>
                    {w.enabled ? 'aktiv' : 'inaktiv'}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mb-1">Skill: {w.skillName} | alle {w.intervalMinutes}min</p>
                {w.lastValue && <p className="text-xs text-gray-400 truncate">Letzter Wert: {w.lastValue}</p>}
                {w.lastTriggeredAt && <p className="text-xs text-gray-500">Letzter Trigger: {new Date(w.lastTriggeredAt).toLocaleString('de-AT')}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Scheduled Tasks */}
      <section>
        <h2 className="text-lg font-medium text-gray-300 mb-3">Geplante Tasks ({data.scheduled.length})</h2>
        {data.scheduled.length === 0 ? (
          <p className="text-gray-500 text-sm">Keine geplanten Tasks.</p>
        ) : (
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0d0d0d] text-gray-400">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-4 py-2 font-medium">Schedule</th>
                  <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Nächste Ausführung</th>
                </tr>
              </thead>
              <tbody>
                {data.scheduled.map((s) => (
                  <tr key={s.id} className="border-t border-[#1f1f1f]">
                    <td className="px-4 py-2 text-gray-200">{s.name}</td>
                    <td className="px-4 py-2 text-gray-400 font-mono text-xs">{s.scheduleValue}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs hidden md:table-cell">
                      {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('de-AT') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Skill Health */}
      <section>
        <h2 className="text-lg font-medium text-gray-300 mb-3">Skill Health</h2>
        {data.skillHealth.length === 0 ? (
          <p className="text-gray-500 text-sm">Keine Skill-Health-Daten.</p>
        ) : (
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {data.skillHealth.map((s) => {
              const status = s.disabledUntil ? 'red' : s.consecutiveFails >= 3 ? 'amber' : 'green';
              return (
                <div key={s.skillName} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={clsx('w-2 h-2 rounded-full', {
                      'bg-green-500': status === 'green',
                      'bg-amber-500': status === 'amber',
                      'bg-red-500': status === 'red',
                    })} />
                    <span className="text-sm text-gray-200 font-mono">{s.skillName}</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {s.totalSuccesses}x OK / {s.totalFailures}x Fehler
                  </p>
                  {s.disabledUntil && <p className="text-xs text-red-400 mt-1">Deaktiviert bis {new Date(s.disabledUntil).toLocaleTimeString('de-AT')}</p>}
                  {s.lastError && <p className="text-xs text-gray-500 truncate mt-1" title={s.lastError}>{s.lastError}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
