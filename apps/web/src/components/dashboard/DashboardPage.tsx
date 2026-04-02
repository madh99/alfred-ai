'use client';

import { useDashboard } from '@/hooks/useDashboard';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { DailyUsageSummary, UsageRecord } from '@/types/api';

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

export function DashboardPage() {
  const { user: authUser } = useConfig();
  const { data, loading, error, refresh } = useDashboard();

  if (loading) return <div className="p-8 text-gray-400">Laden...</div>;
  if (error) return <div className="p-8 text-red-400">Fehler: {error}</div>;
  if (!data) return null;

  const usage = data.usage;
  const today = usage?.today;
  const week = usage?.week ?? [];
  const totalByModel = usage?.total ?? [];
  const weekTotal = week.reduce((s, d) => s + d.totalCostUsd, 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold text-gray-200">Dashboard</h1>
        <div className="flex items-center gap-4">
          {data.uptime != null && (
            <span className="text-xs text-gray-500">Uptime: {formatUptime(data.uptime)}</span>
          )}
          {authUser && (
            <span className="text-xs text-gray-500">
              {authUser.username} ({authUser.role})
            </span>
          )}
          <button onClick={refresh} className="text-sm text-blue-400 hover:text-blue-300">Aktualisieren</button>
        </div>
      </div>

      {/* Adapters + LLM Providers */}
      <section className="grid gap-3 grid-cols-1 md:grid-cols-2">
        {/* Connected Adapters */}
        {data.adapters && (
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Messaging-Adapter</h3>
            <div className="space-y-2">
              {Object.entries(data.adapters).map(([platform, status]) => (
                <div key={platform} className="flex items-center justify-between">
                  <span className="text-sm text-gray-200 capitalize">{platform}</span>
                  <div className="flex items-center gap-2">
                    <span className={clsx('w-2 h-2 rounded-full', status === 'connected' ? 'bg-green-500' : 'bg-red-500')} />
                    <span className={clsx('text-xs', status === 'connected' ? 'text-green-400' : 'text-red-400')}>
                      {status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LLM Providers */}
        {data.llmProviders && (
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">LLM Provider</h3>
            <div className="space-y-2">
              {Object.entries(data.llmProviders).map(([tier, info]) => (
                <div key={tier} className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-gray-500 uppercase">{tier}</span>
                    <p className="text-sm text-gray-200 font-mono">{info.model}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={clsx('w-2 h-2 rounded-full', info.available ? 'bg-green-500' : 'bg-red-500')} />
                    <span className={clsx('text-xs', info.available ? 'text-green-400' : 'text-red-400')}>
                      {info.available ? 'online' : 'offline'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Services (STT, TTS, OCR, Moderation, Embeddings) */}
        {data.services && data.services.length > 0 && (
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">AI Services</h3>
            <div className="space-y-2">
              {data.services.map((svc: { name: string; provider: string; model: string; status: string }) => (
                <div key={svc.name} className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-gray-500">{svc.name}</span>
                    <p className="text-sm text-gray-200 font-mono">{svc.model}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{svc.provider}</span>
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Cost Overview */}
      {usage && (
        <section>
          <h2 className="text-lg font-medium text-gray-300 mb-3">LLM Kosten &amp; Token-Verbrauch</h2>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Heute</p>
              <p className="text-2xl font-bold text-blue-400">{today ? formatCost(today.totalCostUsd) : '$0'}</p>
              <p className="text-xs text-gray-500 mt-1">{today?.totalCalls ?? 0} Calls</p>
            </div>
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Letzte 7 Tage</p>
              <p className="text-2xl font-bold text-blue-400">{formatCost(weekTotal)}</p>
              <p className="text-xs text-gray-500 mt-1">{week.reduce((s, d) => s + d.totalCalls, 0)} Calls</p>
            </div>
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Tokens heute</p>
              <p className="text-lg font-semibold text-gray-200">
                <span className="text-green-400">{formatTokens(today?.totalInputTokens ?? 0)}</span>
                <span className="text-gray-500 mx-1">/</span>
                <span className="text-amber-500">{formatTokens(today?.totalOutputTokens ?? 0)}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">Input / Output</p>
            </div>
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Gesamt (All-Time)</p>
              <p className="text-2xl font-bold text-gray-300">
                {formatCost(totalByModel.reduce((s, m) => s + m.costUsd, 0))}
              </p>
              <p className="text-xs text-gray-500 mt-1">{totalByModel.reduce((s, m) => s + m.calls, 0)} Calls</p>
            </div>
          </div>

          {/* Weekly Cost Bars */}
          {week.length > 0 && (
            <div className="mt-4 bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <p className="text-sm text-gray-400 mb-3">Kosten letzte 7 Tage</p>
              <div className="flex items-end gap-1" style={{ height: '96px' }}>
                {week.map((day) => {
                  const maxCost = Math.max(...week.map(d => d.totalCostUsd), 0.001);
                  const barHeight = Math.max(4, Math.round((day.totalCostUsd / maxCost) * 80));
                  return (
                    <div key={day.date} className="flex-1 flex flex-col items-center justify-end" style={{ height: '96px' }}>
                      <div
                        className="w-full bg-blue-600 rounded-t"
                        style={{ height: `${barHeight}px` }}
                        title={`${day.date}: ${formatCost(day.totalCostUsd)} (${day.totalCalls} Calls)`}
                      />
                      <span className="text-[10px] text-gray-500 mt-1">{day.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Service Costs (STT, TTS, OCR, Moderation) */}
          {data.serviceUsage?.total && data.serviceUsage.total.length > 0 && (
            <div className="mt-4 bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Service</th>
                    <th className="text-left px-4 py-2 font-medium">Model</th>
                    <th className="text-right px-4 py-2 font-medium">Calls</th>
                    <th className="text-right px-4 py-2 font-medium">Einheiten</th>
                    <th className="text-right px-4 py-2 font-medium">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {data.serviceUsage.total.map((s: { service: string; model: string; calls: number; units: number; unitType: string; costUsd: number }) => (
                    <tr key={`${s.service}-${s.model}`} className="border-t border-[#1f1f1f]">
                      <td className="px-4 py-2 text-gray-200 text-xs uppercase">{s.service}</td>
                      <td className="px-4 py-2 text-gray-200 font-mono text-xs">{s.model}</td>
                      <td className="px-4 py-2 text-gray-400 text-right">{s.calls}</td>
                      <td className="px-4 py-2 text-gray-400 text-right">{s.units.toLocaleString('de-AT', { maximumFractionDigits: 1 })} {s.unitType}</td>
                      <td className="px-4 py-2 text-purple-400 text-right font-medium">{formatCost(s.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Cost by Model */}
          {totalByModel.length > 0 && (
            <div className="mt-4 bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Model</th>
                    <th className="text-right px-4 py-2 font-medium">Calls</th>
                    <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Input</th>
                    <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Output</th>
                    <th className="text-right px-4 py-2 font-medium">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {totalByModel.sort((a, b) => b.costUsd - a.costUsd).map((m) => (
                    <tr key={m.model} className="border-t border-[#1f1f1f]">
                      <td className="px-4 py-2 text-gray-200 font-mono text-xs">{m.model}</td>
                      <td className="px-4 py-2 text-gray-400 text-right">{m.calls}</td>
                      <td className="px-4 py-2 text-gray-400 text-right hidden md:table-cell">{formatTokens(m.inputTokens)}</td>
                      <td className="px-4 py-2 text-gray-400 text-right hidden md:table-cell">{formatTokens(m.outputTokens)}</td>
                      <td className="px-4 py-2 text-blue-400 text-right font-medium">{formatCost(m.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

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

      {/* Admin: Per-User Costs */}
      {authUser?.role === 'admin' && (data.userUsage?.length ?? 0) > 0 && (
        <section>
          <h2 className="text-lg font-medium text-gray-300 mb-3">Kosten pro User (letzte 7 Tage)</h2>
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0d0d0d] text-gray-400">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">User</th>
                  <th className="text-right px-4 py-2 font-medium">Calls</th>
                  <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Input</th>
                  <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Output</th>
                  <th className="text-right px-4 py-2 font-medium">Kosten</th>
                </tr>
              </thead>
              <tbody>
                {data.userUsage!.map((u) => (
                  <tr key={u.userId} className="border-t border-[#1f1f1f]">
                    <td className="px-4 py-2 text-gray-200">{u.userId}</td>
                    <td className="px-4 py-2 text-gray-400 text-right">{u.calls}</td>
                    <td className="px-4 py-2 text-gray-400 text-right hidden md:table-cell">{formatTokens(u.inputTokens)}</td>
                    <td className="px-4 py-2 text-gray-400 text-right hidden md:table-cell">{formatTokens(u.outputTokens)}</td>
                    <td className="px-4 py-2 text-blue-400 text-right font-medium">{formatCost(u.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Admin: Skill Usage per User */}
      {authUser?.role === 'admin' && (data.userSkillUsage?.length ?? 0) > 0 && (
        <section>
          <h2 className="text-lg font-medium text-gray-300 mb-3">Skill-Nutzung pro User (letzte 7 Tage)</h2>
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0d0d0d] text-gray-400">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">User</th>
                  <th className="text-left px-4 py-2 font-medium">Skill</th>
                  <th className="text-right px-4 py-2 font-medium">Aufrufe</th>
                  <th className="text-right px-4 py-2 font-medium hidden md:table-cell">OK</th>
                  <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Fehler</th>
                </tr>
              </thead>
              <tbody>
                {data.userSkillUsage!.slice(0, 30).map((s, i) => (
                  <tr key={`${s.userId}-${s.skillName}-${i}`} className="border-t border-[#1f1f1f]">
                    <td className="px-4 py-2 text-gray-200">{s.userId}</td>
                    <td className="px-4 py-2 text-gray-300 font-mono text-xs">{s.skillName}</td>
                    <td className="px-4 py-2 text-gray-400 text-right">{s.calls}</td>
                    <td className="px-4 py-2 text-green-400 text-right hidden md:table-cell">{s.successes}</td>
                    <td className="px-4 py-2 text-red-400 text-right hidden md:table-cell">{s.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Reminders */}
      {(data.reminders?.length ?? 0) > 0 && (
        <section>
          <h2 className="text-lg font-medium text-gray-300 mb-3">Offene Reminder ({data.reminders!.length})</h2>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {data.reminders!.map((r) => {
              const triggerDate = new Date(r.triggerAt);
              const isOverdue = triggerDate < new Date();
              return (
                <div key={r.id} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                  <div className="flex justify-between items-start mb-1">
                    <p className="text-sm text-gray-200">{r.message}</p>
                    <span className={clsx('text-xs px-2 py-0.5 rounded-full', isOverdue ? 'bg-red-500/10 text-red-400' : 'bg-blue-500/10 text-blue-400')}>
                      {isOverdue ? 'überfällig' : 'aktiv'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{triggerDate.toLocaleString('de-AT')} • {r.platform}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

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
