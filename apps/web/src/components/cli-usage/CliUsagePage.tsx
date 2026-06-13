'use client';

/**
 * v866 — Globale CLI-Agent-Usage-Übersicht.
 *
 * Zeigt welcher User welche CLI-Agents (claude-code, codex, …) wie lange und
 * mit wie vielen Tokens genutzt hat — gesamt, pro Projekt, pro Typ, pro
 * Agent/Version/Modell. BEWUSST getrennt vom Alfred-Usage-Tracking: die
 * CLI-Agents laufen auf eigenen Subscriptions/API-Keys.
 */
import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { CliUsageOverview, CliUsageGroupRow } from '@/lib/alfred-client';

const RANGES = [
  { days: 7, label: '7 Tage' },
  { days: 30, label: '30 Tage' },
  { days: 90, label: '90 Tage' },
  { days: 0, label: 'Alles' },
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function typeLabel(t: string): string {
  return ({ project_agent: '🤖 Project-Agent', code_agent: '⚙️ Code-Agent' } as Record<string, string>)[t] ?? t;
}

export function CliUsagePage() {
  const { client } = useConfig();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CliUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await client.fetchCliUsage(days > 0 ? days : undefined);
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-200">🧮 CLI-Agent-Usage</h1>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={clsx(
                'px-2.5 py-1 text-xs rounded border',
                days === r.days
                  ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                  : 'border-[#1f1f1f] text-gray-500 hover:text-gray-300',
              )}
            >{r.label}</button>
          ))}
        </div>
      </div>

      <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-2.5 text-xs text-amber-300/80">
        ℹ️ CLI-Agents (claude-code, codex, …) laufen auf <strong>eigenen Subscriptions/API-Keys</strong> —
        diese Zahlen sind NICHT in Alfreds Betriebskosten (Dashboard → AI Services) enthalten.
        Kosten-Werte sind das vom CLI gemeldete API-Äquivalent (reale Subscription-Kosten können abweichen).
        Bei Claude-Code ist <strong>Cache-Read</strong> meist der größte Token-Posten (Prompt-Caching des
        wiederholten Kontexts) und der Haupttreiber der Kosten-Äquiv. — „Tokens In" zeigt nur den ungecachten Anteil.
        Daten werden seit v866 erfasst.
      </div>

      {loading && !data && <div className="text-gray-500 text-sm">Laden…</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {data && (
        <>
          {/* Totals */}
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 grid grid-cols-2 md:grid-cols-6 gap-3 text-xs">
            <Stat label="Runs" value={String(data.totals.runs)} />
            <Stat label="Laufzeit" value={formatDuration(data.totals.durationS)} accent="text-blue-400" />
            <Stat label="Tokens In" value={formatTokens(data.totals.tokensIn)} />
            {/* v885 — Cache-Read sichtbar: bei Claude-Code der mit Abstand größte
                Posten (Prompt-Caching) und Haupttreiber der Kosten. Ohne diese
                Spalte wirkte "13k In → $205" unerklärlich. */}
            <Stat label="Cache-Read" value={formatTokens(data.totals.cacheReadTokens)} accent="text-purple-400" />
            <Stat label="Tokens Out" value={formatTokens(data.totals.tokensOut)} />
            <Stat label="Kosten-Äquiv." value={`$${data.totals.costUsd.toFixed(2)}`} accent="text-amber-400" />
          </div>

          <GroupTable title="Nach User" rows={data.byUser} keyHeader="User" />
          <GroupTable title="Nach Projekt" rows={data.byProject} keyHeader="Projekt" />
          <GroupTable title="Nach Typ" rows={data.byType.map(r => ({ ...r, key: typeLabel(r.key) }))} keyHeader="Typ" />
          <GroupTable title="Nach Agent / Version / Modell" rows={data.byAgent} keyHeader="Agent" subHeader="Version · Modell" />
          <GroupTable title="Nach Modell" rows={data.byModel} keyHeader="Modell" />

          {data.totals.runs === 0 && (
            <div className="text-sm text-gray-600 italic">
              Noch keine CLI-Runs erfasst — Daten entstehen ab dem ersten Agent-Lauf nach dem v866-Deploy.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className={clsx('text-base font-semibold', accent ?? 'text-gray-200')}>{value}</div>
    </div>
  );
}

function GroupTable({ title, rows, keyHeader, subHeader }: { title: string; rows: CliUsageGroupRow[]; keyHeader: string; subHeader?: string }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium text-gray-400 mb-2">{title}</h2>
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-[#1f1f1f] text-xs">
              <th className="px-4 py-2">{keyHeader}</th>
              {subHeader && <th className="px-4 py-2">{subHeader}</th>}
              <th className="px-4 py-2 text-right">Runs</th>
              <th className="px-4 py-2 text-right">Laufzeit</th>
              <th className="px-4 py-2 text-right">Tokens In</th>
              <th className="px-4 py-2 text-right">Cache-Read</th>
              <th className="px-4 py-2 text-right">Tokens Out</th>
              <th className="px-4 py-2 text-right">Kosten-Äquiv.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[#141414] text-xs">
                <td className="px-4 py-2 text-gray-200">{r.key}</td>
                {subHeader && <td className="px-4 py-2 text-gray-500 font-mono text-[10px]">{r.subKey ?? '—'}</td>}
                <td className="px-4 py-2 text-right text-gray-400">{r.runs}</td>
                <td className="px-4 py-2 text-right font-mono text-blue-400">{formatDuration(r.durationS)}</td>
                <td className="px-4 py-2 text-right font-mono text-gray-300">{formatTokens(r.tokensIn)}</td>
                <td className="px-4 py-2 text-right font-mono text-purple-400">{formatTokens(r.cacheReadTokens)}</td>
                <td className="px-4 py-2 text-right font-mono text-gray-300">{formatTokens(r.tokensOut)}</td>
                <td className="px-4 py-2 text-right font-mono text-amber-400">${r.costUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
