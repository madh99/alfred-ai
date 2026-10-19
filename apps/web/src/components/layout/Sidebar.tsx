'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import { eingangEintraege, hinweisOffen, vorgaengeFuerDich } from '@/components/eingang/eingang-logik';
import { fadenGruppen, fadenTitel, istProjektFaden, fadenAlsMarkdown, type FadenEintrag, type ProjektKurz } from './faden-liste'; // v1497, v1499, v1500

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
  // v1487 — Lebenszeichen (Lage), Vorgänge, Beobachter stehen jetzt in den Gruppen „Eingang" und „Haus & Systeme"
];

// v1487 — Gruppe „Haus & Systeme" wie in der App
const HAUS = [
  { href: `${BASE}/lebenszeichen/`, label: 'Lage', icon: '💓' },
  { href: `${BASE}/befunde/`, label: 'Befunde', icon: '⚠️' },
  { href: `${BASE}/beobachter/`, label: 'Beobachter', icon: '🔭' }, // v1429
];

interface Counts {
  insights: number;
  goals: number;
}

// v1487 — Zähler der Gruppe „Eingang" (null = Quelle nicht verfügbar, z. B. 403 für Nicht-Owner)
interface EingangCounts { eingang: number; vorgaenge: number; bestaetigungen: number; hinweise: number | null }

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
  // v1487 — Gruppen Eingang / Haus & Systeme, default offen
  const [eingangOpen, setEingangOpen] = useState(true);
  const [hausOpen, setHausOpen] = useState(true);
  const [eingangCounts, setEingangCounts] = useState<EingangCounts>({ eingang: 0, vorgaenge: 0, bestaetigungen: 0, hinweise: null });
  const [suche, setSuche] = useState('');
  const [counts, setCounts] = useState<Counts>({ insights: 0, goals: 0 });
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [chats, setChats] = useState<ConvItem[]>([]);
  const [usage, setUsage] = useState<{ tokens?: number; costUsd?: number; calls?: number }>({});
  // v1330 — Gespräche des Owners kanalunabhängig (Hauptgespräch + Fäden), dieselben wie in Telegram und den Apps
  const [faeden, setFaeden] = useState<FadenEintrag[]>([]);
  // v1497 — Weitere, Archiv, Filter, Löschen mit Rückgängig (8 s)
  const [alleFaeden, setAlleFaeden] = useState(false);
  const [archivOffen, setArchivOffen] = useState(false);
  const [fadenFilter, setFadenFilter] = useState('');
  const [geloescht, setGeloescht] = useState<{ faden: string; titel: string } | null>(null);
  const loeschTimer = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // v1499 (D1) — aktive Geräte-Projekte und je Projekt aufgeklapptes „Weitere“
  const [projekteKurz, setProjekteKurz] = useState<ProjektKurz[]>([]);
  const [offeneProjekte, setOffeneProjekte] = useState<Set<string>>(new Set());
  const aktiverFaden = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('faden') : null;
  function faedenLaden() { if (client) client.fetchGespraecheMitProjekten().then(r => { setFaeden(r.faeden); setProjekteKurz(r.projekte); }).catch(() => setFaeden([])); } // v1499
  useEffect(() => { faedenLaden(); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  function neuerFaden() {
    const id = Date.now().toString(36);
    try { localStorage.removeItem('alfred-chat-messages'); } catch {}
    window.location.href = `${BASE}/chat/?faden=${id}`;
  }
  async function fadenUmbenennen(f: string, alt: string) { // v1335
    if (!client) return;
    const titel = prompt('Gespräch umbenennen', alt)?.trim();
    if (!titel) return;
    try { if (await client.renameGespraech(f, titel.slice(0, 80))) setFaeden(prev => prev.map(x => x.faden === f ? { ...x, titel: titel.slice(0, 80) } : x)); } catch {}
  }
  // v1497 — Löschen mit Rückgängig (Owner-Entscheidung 18.10.): sofort ausblenden, erst nach 8 s wirklich löschen
  function fadenLoeschen(f: string, titel: string) {
    if (!client) return;
    clearTimeout(loeschTimer.current.get(f));
    loeschTimer.current.set(f, setTimeout(async () => {
      loeschTimer.current.delete(f);
      try { await client.deleteGespraech(f); } catch {}
      setGeloescht(g => (g?.faden === f ? null : g));
      faedenLaden();
      if (aktiverFaden === f) window.location.href = `${BASE}/chat/`;
    }, 8000));
    setGeloescht({ faden: f, titel });
  }
  function loeschenRueckgaengig() {
    if (!geloescht) return;
    clearTimeout(loeschTimer.current.get(geloescht.faden));
    loeschTimer.current.delete(geloescht.faden);
    setGeloescht(null);
  }
  // v1500 (D2) — abzweigen (neuer Faden mit dem Verlauf) und als Markdown exportieren
  async function fadenAbzweigen(f: FadenEintrag) {
    if (!client) return;
    const r = await client.abzweigeGespraech(f.faden).catch(() => null);
    if (r) window.location.href = `${BASE}/chat/?faden=${encodeURIComponent(r.faden)}`;
  }
  async function fadenExportieren(f: FadenEintrag) {
    if (!client) return;
    const n = await client.fetchGespraechVerlauf(f.faden, 500).catch(() => []);
    const titel = f.faden ? fadenTitel(f) : 'Hauptgespräch';
    const url = URL.createObjectURL(new Blob([fadenAlsMarkdown(titel, n)], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${titel.replace(/[🔨↳]/gu, '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'Gespräch'} ${new Date().toISOString().slice(0, 10)}.md`;
    a.click(); URL.revokeObjectURL(url);
  }
  // v1499 (D1) — Faden einem Projekt zuordnen (Auswahl per Nummer) oder lösen
  function fadenProjekt(f: FadenEintrag) {
    if (!f.faden) return;
    if (f.projekt) { void fadenSetzen(f.faden, { projekt: null }); return; }
    if (projekteKurz.length === 0) { alert('Es gibt noch kein aktives Projekt.'); return; }
    const wahl = prompt(`Einem Projekt zuordnen — Nummer eingeben:\n${projekteKurz.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`)?.trim();
    const nr = Number(wahl);
    if (Number.isInteger(nr) && nr >= 1 && nr <= projekteKurz.length) void fadenSetzen(f.faden, { projekt: projekteKurz[nr - 1].id });
  }
  async function fadenSetzen(f: string, aenderung: { angeheftet?: boolean; archiviert?: boolean; projekt?: string | null }) {
    if (!client) return;
    try { await client.setzeGespraech(f, aenderung); } catch {}
    faedenLaden();
    if (aenderung.archiviert && aktiverFaden === f) window.location.href = `${BASE}/chat/`;
  }
  const gruppen = fadenGruppen(faeden, { alle: alleFaeden, filter: fadenFilter, ausgeblendet: new Set([...loeschTimer.current.keys(), ...(geloescht ? [geloescht.faden] : [])]), projekte: projekteKurz, offeneProjekte });
  const fadenZeile = (f: FadenEintrag, symbol: string) => (
    <div key={f.faden ?? 'haupt'} className={clsx('group flex items-center gap-2 px-3 py-1 rounded-lg', (f.faden ?? null) === (aktiverFaden ?? null) && isActive(`${BASE}/chat`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}>
      <a href={f.faden ? `${BASE}/chat/?faden=${encodeURIComponent(f.faden)}` : `${BASE}/chat/`} className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-xs">{symbol}</span>
        <span className="truncate text-xs" title={f.titel}>{f.faden ? fadenTitel(f) : 'Hauptgespräch'}</span>
      </a>
      {f.faden && (
        <>
          {!f.archiviert && <button onClick={() => fadenSetzen(f.faden!, { angeheftet: !f.angeheftet })} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-amber-400 text-xs" title={f.angeheftet ? 'Lösen' : 'Anheften'}>{f.angeheftet ? '📍' : '📌'}</button>}
          <button onClick={() => fadenAbzweigen(f)} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 text-xs" title="Abzweigen (neuer Faden mit dem Verlauf)">⎇</button>
          <button onClick={() => fadenExportieren(f)} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 text-xs" title="Exportieren (.md)">⤓</button>
          <button onClick={() => fadenUmbenennen(f.faden!, f.titel)} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 text-xs" title="Umbenennen">✎</button>
          {!f.archiviert && !istProjektFaden(f) && <button onClick={() => fadenProjekt(f)} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 text-xs" title={f.projekt ? `Aus Projekt „${f.projekt.name}“ lösen` : 'Einem Projekt zuordnen'}>{f.projekt ? '📤' : '📁'}</button>}
          <button onClick={() => fadenSetzen(f.faden!, { archiviert: !f.archiviert })} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 text-xs" title={f.archiviert ? 'Zurückholen' : 'Archivieren'}>{f.archiviert ? '↩' : '🗄'}</button>
          <button onClick={() => fadenLoeschen(f.faden!, fadenTitel(f))} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs" title="Gespräch löschen">✕</button>
        </>
      )}
    </div>
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPathname(window.location.pathname);
    setSuche(window.location.search);
    try {
      const e = localStorage.getItem('alfred-sidebar-eingang-open');
      if (e !== null) setEingangOpen(e === '1');
      const h = localStorage.getItem('alfred-sidebar-haus-open');
      if (h !== null) setHausOpen(h === '1');
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
    if (typeof window === 'undefined') return;
    try { localStorage.setItem('alfred-sidebar-eingang-open', eingangOpen ? '1' : '0'); } catch {}
  }, [eingangOpen]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem('alfred-sidebar-haus-open', hausOpen ? '1' : '0'); } catch {}
  }, [hausOpen]);

  // v1487 — Zähler für Eingang, Vorgänge, Bestätigungen; alle 60 s, Fehler still
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const laden = async () => {
      const [b, v, a, h] = await Promise.all([
        client.fetchPendingConfirmations().then(l => l.filter(x => x.status === 'pending')).catch(() => null),
        client.fetchVorgaenge().catch(() => null),
        client.fetchOwnerAufgaben().catch(() => null),
        client.fetchHinweise().catch(() => null),
      ]);
      if (cancelled) return;
      const jetzt = new Date();
      const offene = v?.offene ?? [];
      setEingangCounts({
        eingang: eingangEintraege({ bestaetigungen: b ?? [], vorgaenge: offene, aufgaben: a?.aufgaben ?? [], hinweise: h?.hinweise ?? [], jetzt }).length,
        vorgaenge: vorgaengeFuerDich(offene, jetzt).length,
        bestaetigungen: b?.length ?? 0,
        hinweise: h ? h.hinweise.filter(hinweisOffen).length : null,
      });
    };
    laden();
    const t = setInterval(laden, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client]);

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

  // v1487 — Eintrag einer Navigationsgruppe mit optionalem Zähler
  function gruppenEintrag(href: string, icon: string, label: string, aktiv: boolean, zaehler = 0, title?: string) {
    return (
      <a
        key={href}
        href={href}
        title={title}
        className={clsx('flex items-center gap-3 px-3 py-1.5 rounded-lg text-[13px] transition-colors',
          aktiv ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
      >
        <span className="text-base">{icon}</span>
        <span className="flex-1 text-left truncate">{label}</span>
        {zaehler > 0 && (
          <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5">{zaehler}</span>
        )}
      </a>
    );
  }
  function gruppenKopf(name: string, offen: boolean, umschalten: () => void, zaehler = 0) {
    return (
      <button
        onClick={umschalten}
        className="w-full flex items-center justify-between px-3 py-1 text-[11px] uppercase tracking-wide text-gray-500 hover:text-gray-300 font-semibold"
      >
        <span className="flex items-center gap-2">
          <span>{offen ? '▼' : '▶'}</span>
          <span>{name}</span>
        </span>
        {!offen && zaehler > 0 && <span className="text-[10px] text-amber-300/80 normal-case font-normal">{zaehler}</span>}
      </button>
    );
  }
  const bestaetigungenAktiv = isActive(`${BASE}/eingang`) && new URLSearchParams(suche).get('art') === 'bestaetigung';

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
    // v1330 — „Neuer Chat" legt einen Faden an; das Hauptgespräch bleibt über „Gespräche" erreichbar
    if (faeden.length > 0) { neuerFaden(); return; }
    window.location.href = `${BASE}/chat/`;
  }

  return (
    <aside className="w-64 bg-[#0d0d0d] border-r border-[#1f1f1f] flex flex-col h-full text-sm">
      {/* Logo */}
      <div className="px-4 pt-4 pb-2">
        <a href={`${BASE}/`} className="flex items-center gap-2">
          {/* v1476 — App-Icon statt Buchstabe */}
          <img src={`${BASE}/icon-192.png`} alt="" width={24} height={24} className="w-6 h-6 rounded-md" />
          <span className="text-sm font-semibold text-gray-200">Alfred</span>
        </a>
      </div>

      {/* Quick-Actions */}
      <nav className="px-2 py-1 space-y-0.5">
        <button onClick={newChat} className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-gray-300 hover:bg-[#1a1a1a] transition-colors">
          <span className="text-base">💬</span>
          <span>Neuer Chat</span>
        </button>
        {faeden.length > 0 && (
          <div className="pt-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500">Gespräche</div>
            {gruppen.haupt && fadenZeile(gruppen.haupt, '🏠')}
            {gruppen.angeheftet.map(f => fadenZeile(f, '📌'))}
            {gruppen.gespraeche.map(f => fadenZeile(f, '🧵'))}
            {gruppen.weitere > 0 && <button onClick={() => setAlleFaeden(true)} className="w-full text-left px-3 py-1 text-xs text-blue-400 hover:underline">Weitere ({gruppen.weitere})</button>}
            {alleFaeden && !fadenFilter && gruppen.filterSinnvoll && <button onClick={() => setAlleFaeden(false)} className="w-full text-left px-3 py-1 text-xs text-gray-500 hover:underline">Weniger anzeigen</button>}
            {(gruppen.filterSinnvoll || fadenFilter) && (
              <input value={fadenFilter} onChange={e => setFadenFilter(e.target.value)} placeholder="Gespräche filtern" className="mx-3 my-1 w-[calc(100%-1.5rem)] rounded bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-1 text-xs text-gray-300" />
            )}
            {gruppen.archiviert.length > 0 && (
              <>
                <button onClick={() => setArchivOffen(o => !o)} className="w-full text-left px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300">{archivOffen ? '▾' : '▸'} Archiv ({gruppen.archiviert.length})</button>
                {(archivOffen || fadenFilter) && gruppen.archiviert.map(f => fadenZeile(f, '🗄'))}
              </>
            )}
            {geloescht && (
              <div className="mx-3 my-1 flex items-center gap-2 rounded bg-[#1a1a1a] px-2 py-1 text-xs text-gray-300">
                <span className="truncate flex-1">Gelöscht: {geloescht.titel}</span>
                <button onClick={loeschenRueckgaengig} className="text-blue-400 hover:underline">Rückgängig</button>
              </div>
            )}
          </div>
        )}
        <a
          href={`${BASE}/history/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/history`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">🔍</span>
          <span>Suche &amp; History</span>
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
          href={`${BASE}/social/`}
          className={clsx('w-full flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors',
            isActive(`${BASE}/social`) ? 'bg-blue-500/10 text-blue-400' : 'text-gray-300 hover:bg-[#1a1a1a]')}
        >
          <span className="text-base">📣</span>
          <span>Social Media</span>
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
        {/* v1487 — Gruppe „Eingang" wie in der App: alles, was den Owner braucht */}
        <div>
          {gruppenKopf('Eingang', eingangOpen, () => setEingangOpen(o => !o), eingangCounts.eingang)}
          {eingangOpen && (
            <div className="space-y-0.5 mt-1">
              {gruppenEintrag(`${BASE}/eingang/`, '📥', 'Eingang', isActive(`${BASE}/eingang`) && !bestaetigungenAktiv, eingangCounts.eingang, 'Alles, was dich braucht — das Dringendste zuerst')}
              {gruppenEintrag(`${BASE}/vorgaenge/`, '🗂️', 'Vorgänge', isActive(`${BASE}/vorgaenge`), eingangCounts.vorgaenge, 'Offene Vorgänge für dich')}
              {gruppenEintrag(`${BASE}/insights/`, '💡', 'Hinweise', isActive(`${BASE}/insights`), eingangCounts.hinweise ?? counts.insights)}
              {/* Bestätigungen haben keine eigene Seite — der Eintrag zeigt den Eingang gefiltert, nur wenn welche offen sind */}
              {eingangCounts.bestaetigungen > 0 && gruppenEintrag(`${BASE}/eingang/?art=bestaetigung`, '🔔', 'Bestätigungen', bestaetigungenAktiv, eingangCounts.bestaetigungen, 'Offene Bestätigungen')}
            </div>
          )}
        </div>

        {/* v1487 — Gruppe „Haus & Systeme" */}
        <div>
          {gruppenKopf('Haus & Systeme', hausOpen, () => setHausOpen(o => !o))}
          {hausOpen && (
            <div className="space-y-0.5 mt-1">
              {HAUS.map(h => gruppenEintrag(h.href, h.icon, h.label, isActive(h.href)))}
            </div>
          )}
        </div>

        {/* Projekte (collapsible) */}
        {(projects.length > 0 || gruppen.projekte.some(g => g.faeden.length > 0)) && (
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
                {[...projects, ...gruppen.projekte.filter(g => g.faeden.length > 0 && !projects.some(p => p.id === g.id)).map(g => ({ id: g.id, name: g.name }))].map(p => {
                  const g = gruppen.projekte.find(x => x.id === p.id); // v1499 (D1) — Fäden des Projekts darunter
                  return (
                    <div key={p.id}>
                      <button
                        onClick={() => openProject(p.id)}
                        className="w-full flex items-center gap-2 px-3 py-1 text-[13px] text-gray-300 hover:bg-[#1a1a1a] rounded text-left"
                      >
                        <span className="text-[11px]">📁</span>
                        <span className="truncate flex-1">{p.name}</span>
                      </button>
                      {g && g.faeden.length > 0 && (
                        <div className="ml-4">
                          {g.faeden.map(f => fadenZeile(f, istProjektFaden(f) ? '🔨' : '🧵'))}
                          {g.weitere > 0 && <button onClick={() => setOffeneProjekte(s => new Set([...s, p.id]))} className="w-full text-left px-3 py-1 text-xs text-blue-400 hover:underline">Weitere ({g.weitere})</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
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
