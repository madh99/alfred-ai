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

export function HistoryPage() {
  const { client } = useConfig();
  const [conversations, setConversations] = useState<ConversationSummaryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageItem[]>([]);
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const loadList = useCallback(async () => {
    if (!client) return;
    setLoadingList(true); setError(null);
    try {
      const filter = platformFilter === 'all' ? undefined : { platform: platformFilter };
      const list = await client.fetchConversations(filter);
      setConversations(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoadingList(false); }
  }, [client, platformFilter]);

  useEffect(() => { loadList(); }, [loadList]);

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
      // Heuristic: if we got exactly 50, assume more exist
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
      if (older.length === 0) {
        setHasMore(false);
      } else {
        setMessages(prev => [...older, ...prev]);
        setHasMore(older.length >= 50);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoadingMore(false); }
  }, [client, selectedId, messages, loadingMore, hasMore]);

  const jumpToSearchResult = useCallback(async (result: ConversationSearchResult) => {
    await loadConversation(result.conversationId);
    setSearchOpen(false);
    // Scroll-to-message handled by ConversationDetail via prop
  }, [loadConversation]);

  const selectedConv = useMemo(
    () => conversations.find(c => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  // Keyboard: Ctrl/Cmd+K = open search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function exportConversation() {
    if (!selectedConv) return;
    const lines = [
      `# Conversation Export`,
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
        onSelect={loadConversation}
        onPlatformChange={(p) => setPlatformFilter(p as PlatformFilter)}
        onSearch={() => setSearchOpen(true)}
        onRefresh={loadList}
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
