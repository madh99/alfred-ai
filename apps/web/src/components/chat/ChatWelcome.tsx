'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface QuickCard {
  icon: string;
  title: string;
  body: string;
  href?: string;
  count?: number;
}

/**
 * v646 — Chat-Welcome-View: zentriertes Hero + Connector-Cards für aktuelle Insights /
 * Pending-Confirmations / Active-Project-Agents / Open-Items.
 *
 * Wird in ChatPage angezeigt sobald `messages.length === 0`. Daten kommen aus existing
 * Endpoints, fail gracefully wenn ein Endpoint nicht antwortet.
 */
export function ChatWelcome() {
  const { client } = useConfig();
  const [cards, setCards] = useState<QuickCard[]>([]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      const out: QuickCard[] = [];
      // 1. Pending Insights
      try {
        const stats = await client.fetchInsightsStats();
        const pending = Number(stats.pending ?? 0);
        if (pending > 0) out.push({
          icon: '💡', title: 'Insights warten',
          body: `${pending} offene Insight${pending === 1 ? '' : 's'} — Cross-Domain-Vorschläge prüfen.`,
          href: '/alfred/insights/', count: pending,
        });
      } catch {}
      // 2. Pending Confirmations
      try {
        const confs = await client.fetchPendingConfirmations();
        if (confs.length > 0) out.push({
          icon: '✅', title: 'Bestätigungen offen',
          body: `${confs.length} Aktion${confs.length === 1 ? '' : 'en'} warten auf deine Freigabe.`,
          count: confs.length,
        });
      } catch {}
      // 3. Reminders
      try {
        const reminders = await client.fetchPendingReminders();
        if (reminders.length > 0) {
          const next = reminders.sort((a, b) => new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime())[0];
          out.push({
            icon: '⏰', title: 'Reminder anstehend',
            body: next ? `Nächster: "${(next.message ?? '').slice(0, 60)}" um ${new Date(next.triggerAt).toLocaleString('de-AT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}` : `${reminders.length} Reminder`,
            count: reminders.length,
          });
        }
      } catch {}
      // 4. Goals (drift)
      try {
        const goals = await client.fetchGoals({ status: 'active' });
        if (goals.length > 0) {
          const overdue = goals.filter(g => {
            if (!g.lastCheckedAt) return true;
            const elapsedDays = (Date.now() - new Date(g.lastCheckedAt).getTime()) / 86400_000;
            return elapsedDays >= g.checkFrequencyDays;
          });
          if (overdue.length > 0) out.push({
            icon: '🎯', title: 'Ziel-Check fällig',
            body: `${overdue.length} von ${goals.length} aktiven Zielen brauchen einen Check.`,
            href: '/alfred/goals/', count: overdue.length,
          });
        }
      } catch {}
      // 5. Active Project-Agents
      try {
        const agents = await client.fetchProjectAgents();
        const running = (agents as any[]).filter(a => a.currentPhase !== 'done' && a.currentPhase !== 'failed');
        if (running.length > 0) out.push({
          icon: '🤖', title: 'Project-Agent läuft',
          body: `${running.length} Session${running.length === 1 ? '' : 's'} aktiv — Phase: ${running[0].currentPhase}`,
          href: '/alfred/project-agents/', count: running.length,
        });
      } catch {}

      // Fallback: wenn nichts da ist, statische Schnellzugriff-Karten
      if (out.length === 0) {
        out.push(
          { icon: '🧠', title: 'Knowledge-Graph', body: 'Personen, Orte, Items — Alfreds Wissen über deine Welt', href: '/alfred/knowledge/' },
          { icon: '📖', title: 'Runbooks', body: 'Wiederholbare Abläufe aus erfolgreichen Sessions', href: '/alfred/runbooks/' },
          { icon: '🗂️', title: 'Projekte', body: 'Langfristige Projekt-Container mit Sessions + Open-Items', href: '/alfred/projects/' },
        );
      }
      if (!cancelled) setCards(out.slice(0, 4));
    })();
    return () => { cancelled = true; };
  }, [client]);

  return (
    <div className="max-w-3xl mx-auto px-4 pt-12 pb-8">
      <div className="text-center mb-10">
        <h1 className="text-2xl md:text-3xl font-semibold text-gray-100 mb-2">Woran sollen wir arbeiten?</h1>
        <p className="text-sm text-gray-500">Stelle eine Frage, gib einen Befehl ein, oder nutze <span className="font-mono text-gray-400">/</span> für die Befehlspalette.</p>
      </div>

      {cards.length > 0 && (
        <div className={`grid gap-3 ${cards.length === 1 ? 'grid-cols-1' : cards.length === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3'} max-w-3xl mx-auto`}>
          {cards.map((c, i) => {
            const inner = (
              <>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-2xl">{c.icon}</span>
                  {c.count != null && c.count > 0 && (
                    <span className="text-[10px] bg-blue-500/15 border border-blue-500/40 text-blue-300 rounded px-1.5 py-0.5">{c.count}</span>
                  )}
                </div>
                <h3 className="text-sm font-semibold text-gray-100 mb-1">{c.title}</h3>
                <p className="text-xs text-gray-400">{c.body}</p>
              </>
            );
            const cls = 'bg-[#111] border border-[#1f1f1f] rounded-xl p-4 hover:border-blue-500/40 transition-colors text-left';
            return c.href
              ? <a key={i} href={c.href} className={cls + ' block'}>{inner}</a>
              : <div key={i} className={cls}>{inner}</div>;
          })}
        </div>
      )}
    </div>
  );
}
