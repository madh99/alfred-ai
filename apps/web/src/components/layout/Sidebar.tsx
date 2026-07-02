'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';

const BASE = '/alfred';

// v646 — Tools-Sektion: alles was nicht primary (Chat/Insights/Goals) ist
const TOOLS = [
  { href: `${BASE}/dashboard/`, label: 'Dashboard', icon: '📊' },
  { href: `${BASE}/knowledge/`, label: 'Knowledge', icon: '🧠' },
  { href: `${BASE}/memories/`, label: 'Memories', icon: '📝' },
  { href: `${BASE}/todos/`, label: 'Todos', icon: '✅' },
  { href: `${BASE}/notes/`, label: 'Notes', icon: '🗒️' },
  { href: `${BASE}/runbooks/`, label: 'Runbooks', icon: '📖' },
  { href: `${BASE}/project-agents/`, label: 'Project Agents', icon: '🤖' },
  { href: `${BASE}/cli-usage/`, label: 'CLI-Usage', icon: '🧮' },
  { href: `${BASE}/sandboxes/`, label: 'Sandboxes', icon: '📦' },
  { href: `${BASE}/background-tasks/`, label: 'Background Tasks', icon: '⚙️' },
  { href: `${BASE}/cmdb/`, label: 'CMDB', icon: '🖥️' },
  { href: `${BASE}/itsm/`, label: 'ITSM', icon: '🔧' },
  { href: `${BASE}/services/`, label: 'Services', icon: '⚙️' },
  { href: `${BASE}/docs/`, label: 'Docs', icon: '📄' },
  { href: `${BASE}/logs/`, label: 'Logs', icon: '📋' },
  { href: `${BASE}/cluster/`, label: 'Cluster', icon: '🔗' },
];

interface Counts {
  insights: number;
  goals: number;
}

interface ProjectItem { id: string; name: string; status: string }
interface ConvItem { id: string; chatId: string; customLabel?: string; platform: string; pinnedAt?: string; lastMessageAt?: string; messageCount: number }

export function Sidebar() {
  const { user, logout, client } = useConfig();
  const [pathname, setPathname] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // v668 — Chats & Projekte collapsible (Listen können lang werden)
  const [chatsOpen, setChatsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [counts, setCounts] = useState<Counts>({ insights: 0, goals: 0 });
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [chats, setChats] = useState<ConvItem[]>([]);
  const [usage, setUsage] = useState<{ tokens?: number; costUsd?: number; calls?: number }>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPathname(window.location.pathname);
    try {
      setToolsOpen(localStorage.getItem('alfred-sidebar-tools-open') === '1');
      // v668 — Chats/Projekte default offen, aber persistierter Zustand gewinnt
      const c = localStorage.getItem('alfred-sidebar-chats-open');
      if (c !== null) setChatsOpen(c === '1');
      const p = localStorage.getItem('alfred-sidebar-projects-open');
      if (p !== null) setProjectsOpen(p === '1');
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem('alfred-sidebar-tools-open', toolsOpen ? '1' : '0'); } catch {}
  }, [toolsOpen]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem('alfred-sidebar-chats-open', chatsOpen ? '1' : '0'); } catch {}
  }, [chatsOpen]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem('alfred-sidebar-projects-open', projectsOpen ? '1' : '0'); } catch {}
  }, [projectsOpen]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const [stats, goals, projs, convs, dash] = await Promise.all([
          client.fetchInsightsStats().catch(() => ({} as Record<string, number>)),
          client.fetchGoals({ status: 'active' }).catch(() => []),
          client.fetchProjects({ status: 'active' }).catch(() => []),
          client.fetchConversations({ limit: 10, sort: 'pinned_first' }).catch(() => []),
          client.fetchDashboard('today').catch(() => null),
        ]);
        if (cancelled) return;
        setCounts({
          insights: Number(stats.pending ?? 0),
          goals: Array.isArray(goals) ? goals.length : 0,
        });
        setProjects((projs as any[]).slice(0, 8).map(p => ({ id: p.id, name: p.name, status: p.status })));
        setChats((convs as any[]).filter(c => !c.chatId?.startsWith('scheduled-')).slice(0, 10).map(c => ({
          id: c.id, chatId: c.chatId, customLabel: c.customLabel, platform: c.platform,
          pinnedAt: c.pinnedAt, lastMessageAt: c.lastMessageAt, messageCount: c.messageCount,
        })));
        if (dash?.usage?.today) {
          setUsage({
            tokens: (dash.usage.today.totalInputTokens ?? 0) + (dash.usage.today.totalOutputTokens ?? 0),
            costUsd: dash.usage.today.totalCostUsd,
            calls: dash.usage.today.totalCalls,
          });
        }
      } catch { /* sidebar data fetch failed — degrade gracefully */ }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const isActive = (href: string) => {
    const path = href.replace(/\/$/, '');
    return pathname === path || (pathname.startsWith(path + '/') && path !== BASE);
  };

  const platformIcon = (p: string): string => ({
    telegram: '✈️', matrix: '🔷', api: '🌐', discord: '🎮', whatsapp: '💚', signal: '🔵',
  } as Record<string, string>)[p] ?? '💬';

  // v678 — Project-Chats erkennen + projektbezogenen Anzeige-Namen ableiten
  function chatDisplayLabel(c: ConvItem): { label: string; icon: string; isProject: boolean } {
    if (c.chatId?.startsWith('project:')) {
      const projectId = c.chatId.slice('project:'.length);
      const proj = projects.find(p => p.id === projectId);
      return {
        label: proj ? proj.name.slice(0, 50) : `Projekt ${projectId.slice(0, 8)}`,
        icon: '📁',
        isProject: true,
      };
    }
    return {
      label: c.customLabel ?? c.chatId,
      icon: platformIcon(c.platform),
      isProject: false,
    };
  }

  function openConversation(c: ConvItem) {
    // v647 — api/web-Conversations → direkt in ChatPage laden.
    // v678 — Project-Chats (chatId='project:<uuid>') gehören NICHT in den allgemeinen
    // Web-Chat (der hat eine fixe chatId='web-chat-<userId>'). Sie müssen in die
    // Projekt-Detail-View damit die Project-Chat-Sektion den richtigen Kontext lädt.
    if (c.chatId?.startsWith('project:')) {
      const projectId = c.chatId.slice('project:'.length);
      window.location.href = `${BASE}/projects/?id=${encodeURIComponent(projectId)}&chat=open`;
      return;
    }
    if (c.platform === 'api') {
      try { localStorage.setItem('alfred-chat-active-conversation-id', c.id); } catch {}
      window.location.href = `${BASE}/chat/`;
    } else {
      window.location.href = `${BASE}/history/?id=${encodeURIComponent(c.id)}`;
    }
  }

  function openProject(id: string) {
    window.location.href = `${BASE}/projects/?id=${encodeURIComponent(id)}`;
  }

  function newChat() {
    try { localStorage.removeItem('alfred-chat-active-conversation-id'); } catch {}
    try { localStorage.removeItem('alfred-chat-messages'); } catch {}
    window.location.href = `${BASE}/chat/`;
  }

  return (
    <aside className="w-64 bg-[#0d0d0d] border-r border-[#1f1f1f] flex flex-col h-full text-sm">
      {/* Logo */}
      <div className="px-4 pt-4 pb-2">
        <a href={`${BASE}/`} className="flex items-center gap-2">
          <span className="text-xl font-bold text-blue-500 font-mono">A</span>
          <span className="text-sm font-semibold text-gray-200">Alfred</span>
        </a>
      </div>

      {/* Quick-Actions */}
      <nav className="px-2 py-1 space-y-0.5">
        <button onClick={newChat} className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-gray-300 hover:bg-[#1a1a1a] transition-colors">
          <span className="text-base">💬</span>
          <span>Neuer Chat</span>
        </button>
        <a
          href={`${BASE}/history/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/history`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">🔍</span>
          <span>Suche &amp; History</span>
        </a>
        <a
          href={`${BASE}/insights/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/insights`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">💡</span>
          <span className="flex-1 text-left">Insights</span>
          {counts.insights > 0 && (
            <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5">{counts.insights}</span>
          )}
        </a>
        <a
          href={`${BASE}/interests/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/interests`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">📡</span>
          <span>Interessen</span>
        </a>
        <a
          href={`${BASE}/goals/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/goals`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">🎯</span>
          <span className="flex-1 text-left">Goals</span>
          {counts.goals > 0 && (
            <span className="text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30 rounded px-1.5 py-0.5">{counts.goals}</span>
          )}
        </a>
      </nav>

      {/* Scrollable area with Projekte / Chats / Tools */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-3">
        {/* Projekte (collapsible) */}
        {projects.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1">
              <button
                onClick={() => setProjectsOpen(o => !o)}
                className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-500 hover:text-gray-300 font-semibold"
              >
                <span>{projectsOpen ? '▼' : '▶'}</span>
                <span>Projekte</span>
                <span className="text-[10px] text-gray-600 normal-case font-normal">({projects.length})</span>
              </button>
              <a href={`${BASE}/projects/`} className="text-[10px] text-gray-500 hover:text-blue-400">Alle ›</a>
            </div>
            {projectsOpen && (
              <div className="space-y-0.5">
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => openProject(p.id)}
                    className="w-full flex items-center gap-2 px-3 py-1 text-[13px] text-gray-300 hover:bg-[#1a1a1a] rounded text-left"
                  >
                    <span className="text-[11px]">📁</span>
                    <span className="truncate flex-1">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Chats (collapsible) */}
        {chats.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1">
              <button
                onClick={() => setChatsOpen(o => !o)}
                className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-500 hover:text-gray-300 font-semibold"
              >
                <span>{chatsOpen ? '▼' : '▶'}</span>
                <span>Chats</span>
                <span className="text-[10px] text-gray-600 normal-case font-normal">({chats.length})</span>
              </button>
              <a href={`${BASE}/history/`} className="text-[10px] text-gray-500 hover:text-blue-400">Alle ›</a>
            </div>
            {chatsOpen && (
              <div className="space-y-0.5">
                {chats.map(c => {
                  const display = chatDisplayLabel(c);
                  return (
                    <button
                      key={c.id}
                      onClick={() => openConversation(c)}
                      className="w-full flex items-center gap-2 px-3 py-1 text-[13px] text-gray-300 hover:bg-[#1a1a1a] rounded text-left"
                      title={display.isProject ? 'Projekt-Chat öffnen' : (c.platform === 'api' ? 'Im Chat fortsetzen' : 'In History öffnen (read-only)')}
                    >
                      {c.pinnedAt && <span className="text-amber-400 text-[10px]">📌</span>}
                      <span className="text-[11px]">{display.icon}</span>
                      <span className="truncate flex-1">{display.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tools (collapsible) */}
        <div>
          <button
            onClick={() => setToolsOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-1 text-[11px] uppercase tracking-wide text-gray-500 hover:text-gray-300 font-semibold"
          >
            <span className="flex items-center gap-2">
              <span>{toolsOpen ? '▼' : '▶'}</span>
              <span>🛠️ Tools</span>
            </span>
            <span className="text-[10px] text-gray-600">{TOOLS.length}</span>
          </button>
          {toolsOpen && (
            <div className="space-y-0.5 mt-1">
              {TOOLS.map(t => (
                <a
                  key={t.href}
                  href={t.href}
                  className={clsx('flex items-center gap-3 px-3 py-1 text-[13px] rounded transition-colors',
                    isActive(t.href) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-200')}
                >
                  <span className="text-base">{t.icon}</span>
                  <span>{t.label}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Account-Box (expandable) */}
      <div className="border-t border-[#1f1f1f]">
        <button
          onClick={() => setAccountOpen(o => !o)}
          className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[#161616]"
        >
          <span className="text-base">👤</span>
          <span className="flex-1 text-left">
            <div className="text-[12px] text-gray-200 truncate">{user?.username ?? '—'}</div>
            <div className="text-[10px] text-gray-500">{user?.role ?? ''}</div>
          </span>
          <span className="text-[10px] text-gray-500">{accountOpen ? '▼' : '▲'}</span>
        </button>
        {accountOpen && (
          <div className="px-2 pb-2 space-y-0.5 border-t border-[#1f1f1f]">
            <a href={`${BASE}/settings/`} className={clsx('flex items-center gap-3 px-3 py-1.5 rounded text-[13px]',
              isActive(`${BASE}/settings`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}>
              <span className="text-base">⚙️</span>
              <span>Einstellungen</span>
            </a>
            <a href={`${BASE}/dashboard/`} className="flex items-center gap-3 px-3 py-1.5 rounded text-[13px] text-gray-300 hover:bg-[#1a1a1a]">
              <span className="text-base">📊</span>
              <span className="flex-1 text-left">Verbrauch</span>
              {usage.tokens != null && (
                <span className="text-[10px] text-gray-500" title={usage.calls ? `${usage.calls} Calls` : undefined}>
                  {usage.tokens >= 1000 ? (usage.tokens / 1000).toFixed(1) + 'k' : usage.tokens} Tok
                  {usage.costUsd ? ` · $${usage.costUsd.toFixed(2)}` : ''}
                </span>
              )}
            </a>
            <a
              href="https://github.com/madh99/alfred-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-1.5 rounded text-[13px] text-gray-400 hover:bg-[#1a1a1a]"
            >
              <span className="text-base">📦</span>
              <span>GitHub</span>
              <span className="text-[10px] text-gray-600">↗</span>
            </a>
            {user && (
              <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-1.5 rounded text-[13px] text-red-400 hover:bg-red-500/10">
                <span className="text-base">↩</span>
                <span>Abmelden</span>
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
