'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type {
  ConversationSummaryItem,
  ConversationMessageItem,
  ConversationSummary,
  ConversationSearchResult,
} from '@/lib/alfred-client';
import { ConversationsSidebar } from './ConversationsSidebar';
import { ConversationDetail } from './ConversationDetail';
import { SearchOverlay } from './SearchOverlay';

const PLATFORM_FILTERS = ['all', 'telegram', 'matrix', 'api', 'discord', 'whatsapp', 'signal'] as const;
type PlatformFilter = typeof PLATFORM_FILTERS[number];

const PAGE_SIZE = 100;

function dateRangeToIso(range: string): { since?: string; until?: string } {
  const now = Date.now();
  const day = 86400_000;
  switch (range) {
    case 'today': return { since: new Date(now - 1 * day).toISOString() };
    case 'week': return { since: new Date(now - 7 * day).toISOString() };
    case 'month': return { since: new Date(now - 30 * day).toISOString() };
    case 'quarter': return { since: new Date(now - 90 * day).toISOString() };
    case 'year': return { since: new Date(now - 365 * day).toISOString() };
    default: return {};
  }
}

export function HistoryPage() {
  const { client } = useConfig();
  const [conversations, setConversations] = useState<ConversationSummaryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageItem[]>([]);
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMorePages, setLoadingMorePages] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasMorePages, setHasMorePages] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [sortBy, setSortBy] = useState<string>('pinned_first');
  const [dateRange, setDateRange] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // v644 — Bulk
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());

  const loadList = useCallback(async (offset = 0, append = false) => {
    if (!client) return;
    if (offset === 0) setLoadingList(true);
    else setLoadingMorePages(true);
    setError(null);
    try {
      const filter: any = { limit: PAGE_SIZE, offset, sort: sortBy };
      if (platformFilter !== 'all') filter.platform = platformFilter;
      const range = dateRangeToIso(dateRange);
      if (range.since) filter.since = range.since;
      if (range.until) filter.until = range.until;
      const list = await client.fetchConversations(filter);
      setConversations(prev => append ? [...prev, ...list] : list);
      setHasMorePages(list.length >= PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
      setLoadingMorePages(false);
    }
  }, [client, platformFilter, sortBy, dateRange]);

  useEffect(() => { loadList(0, false); }, [loadList]);

  const loadConversation = useCallback(async (id: string) => {
    if (!client) return;
    setSelectedId(id);
    setLoadingDetail(true); setError(null); setHasMore(true);
    try {
      const [msgs, sum] = await Promise.all([
        client.fetchConversationMessages(id, { limit: 50 }),
        client.fetchConversationSummary(id),
      ]);
      setMessages(msgs);
      setSummary(sum);
      setHasMore(msgs.length >= 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoadingDetail(false); }
  }, [client]);

  const loadOlder = useCallback(async () => {
    if (!client || !selectedId || messages.length === 0 || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const before = messages[0].createdAt;
      const older = await client.fetchConversationMessages(selectedId, { beforeIso: before, limit: 50 });
      if (older.length === 0) setHasMore(false);
      else { setMessages(prev => [...older, ...prev]); setHasMore(older.length >= 50); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoadingMore(false); }
  }, [client, selectedId, messages, loadingMore, hasMore]);

  const jumpToSearchResult = useCallback(async (result: ConversationSearchResult) => {
    await loadConversation(result.conversationId);
    setSearchOpen(false);
  }, [loadConversation]);

  const selectedConv = useMemo(
    () => conversations.find(c => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(true); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Lifecycle actions ──
  async function handlePin(id: string, pinned: boolean) {
    if (!client) return;
    try { await client.patchConversation(id, { pinned }); await loadList(0, false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function handleRename(id: string, label: string) {
    if (!client) return;
    try { await client.patchConversation(id, { customLabel: label.length > 0 ? label : null }); await loadList(0, false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function handleDelete(id: string) {
    if (!client) return;
    if (!confirm('Conversation wirklich löschen? (Soft-Delete — kann via Backend wiederhergestellt werden)')) return;
    try {
      await client.deleteConversation(id);
      if (selectedId === id) { setSelectedId(null); setMessages([]); setSummary(null); }
      await loadList(0, false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function handleContinueInChat(id: string) {
    // Speichern als aktive Conversation für den Chat und dorthin navigieren
    try { localStorage.setItem('alfred-chat-active-conversation-id', id); } catch {}
    window.location.href = '/alfred/chat/';
  }
  async function handleBulkExport() {
    if (!client || bulkSelected.size === 0) return;
    try {
      const r = await client.exportConversations([...bulkSelected]);
      // Pack als ZIP-äquivalent: einzelne Downloads (kein zip-lib im Frontend — eines pro File)
      for (const e of r.entries) {
        const blob = new Blob([e.content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = e.filename;
        a.click();
        URL.revokeObjectURL(url);
        await new Promise(res => setTimeout(res, 80)); // small gap so browser handles multi-download
      }
      setBulkMode(false);
      setBulkSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function toggleBulkSelect(id: string) {
    setBulkSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleBulkMode() {
    setBulkMode(b => !b);
    setBulkSelected(new Set());
  }

  async function handleBranch(messageId: string) {
    if (!client || !selectedId) return;
    if (!confirm('An dieser Nachricht eine neue Conversation forken? Die neue Conversation enthält alle Messages bis hierher.')) return;
    try {
      const newId = await client.branchConversation(selectedId, messageId);
      await loadList(0, false);
      await loadConversation(newId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleReplay(messageId: string) {
    if (!client || !selectedId) return;
    if (!confirm('Tool-Call dieser Nachricht erneut ausführen? Achtung: kann Daten verändern.')) return;
    try {
      const r = await client.replayToolCall(selectedId, messageId);
      if (r.ok) {
        alert('▶ Replay ausgeführt:\n\n' + JSON.stringify(r.result, null, 2).slice(0, 2000));
      } else {
        alert('Fehler: ' + r.reason);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function exportConversation() {
    if (!selectedConv) return;
    const lines = [
      `# ${selectedConv.customLabel ?? 'Conversation Export'}`,
      `Platform: ${selectedConv.platform}`,
      `ChatId: ${selectedConv.chatId}`,
      `Created: ${selectedConv.createdAt}`,
      `Messages: ${messages.length} (von insgesamt ${selectedConv.messageCount})`,
      ``,
      ...messages.map(m =>
        `## ${m.role.toUpperCase()} — ${m.createdAt}\n${m.content}\n${m.toolCalls ? `\n[tool-calls]\n${m.toolCalls}\n` : ''}`,
      ),
    ];
    const md = lines.join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${selectedConv.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full">
      <ConversationsSidebar
        conversations={conversations}
        loading={loadingList}
        selectedId={selectedId}
        platformFilter={platformFilter}
        platforms={PLATFORM_FILTERS}
        sortBy={sortBy}
        dateRange={dateRange}
        selectedIds={bulkSelected}
        bulkMode={bulkMode}
        onSelect={loadConversation}
        onPlatformChange={(p) => setPlatformFilter(p as PlatformFilter)}
        onSortChange={setSortBy}
        onDateRangeChange={setDateRange}
        onSearch={() => setSearchOpen(true)}
        onRefresh={() => loadList(0, false)}
        onLoadMore={() => loadList(conversations.length, true)}
        hasMore={hasMorePages}
        loadingMore={loadingMorePages}
        onToggleBulkMode={toggleBulkMode}
        onToggleSelect={toggleBulkSelect}
        onBulkExport={handleBulkExport}
        onPin={handlePin}
        onRename={handleRename}
        onDelete={handleDelete}
        onContinueInChat={handleContinueInChat}
      />
      <div className="flex-1 overflow-hidden flex flex-col">
        {error && (
          <div className="bg-red-500/10 border-b border-red-500/40 px-4 py-2 text-sm text-red-400">{error}</div>
        )}
        <ConversationDetail
          conversation={selectedConv}
          messages={messages}
          summary={summary}
          loading={loadingDetail}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadOlder={loadOlder}
          onExport={exportConversation}
          onBranchAtMessage={handleBranch}
          onReplayMessage={handleReplay}
          onContinueInChat={() => selectedConv && handleContinueInChat(selectedConv.id)}
        />
      </div>
      {searchOpen && (
        <SearchOverlay
          onClose={() => setSearchOpen(false)}
          onSelect={jumpToSearchResult}
        />
      )}
    </div>
  );
}
