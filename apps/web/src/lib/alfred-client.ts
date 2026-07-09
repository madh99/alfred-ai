import { readSseStream } from './sse-reader';
import type { DashboardData, HealthData, Attachment } from '@/types/api';

// v847 — Strukturiertes Progress-Event analog zu @alfred/core ProgressEvent.
// Wenn der Client onProgress NICHT setzt, fällt der Stream auf legacy onStatus zurück.
export interface ProgressEventDto {
  kind: 'thinking' | 'tool_call' | 'tool_done' | 'tool_error' | 'status';
  text: string;
  tool?: string;
  toolInput?: string;
  durationMs?: number;
  /** Optional ms-Timestamp damit UI sortieren kann (vom Adapter gesetzt). */
  ts?: number;
}

export interface StreamCallbacks {
  onStatus: (text: string) => void;
  onResponse: (text: string) => void;
  onAttachment: (a: Attachment) => void;
  onDone: () => void;
  onError: (err: string) => void;
  /** v847 — strukturiertes progress-event mit kind. Fallback auf onStatus wenn nicht gesetzt. */
  onProgress?: (evt: ProgressEventDto) => void;
}

export class AlfredClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  updateConfig(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * Stream a message to Alfred via POST /api/message (SSE).
   * Returns an abort function.
   */
  streamMessage(
    text: string,
    chatId: string,
    userId: string,
    callbacks: StreamCallbacks,
    /** v657 — optionaler Reply-Kontext (vom Reply-Button in der Chat-UI) */
    replyTo?: { messageId?: string; text?: string; from?: string },
  ): () => void {
    const controller = new AbortController();

    (async () => {
      try {
        const body: Record<string, unknown> = { text, chatId, userId };
        if (replyTo?.text) {
          body.replyToText = replyTo.text;
          if (replyTo.from) body.replyToFrom = replyTo.from;
          if (replyTo.messageId) body.replyToMessageId = replyTo.messageId;
        }
        const res = await fetch(`${this.baseUrl}/api/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          callbacks.onError(`HTTP ${res.status}: ${res.statusText}`);
          return;
        }

        for await (const { event, data } of readSseStream(res)) {
          try {
            const parsed = JSON.parse(data);
            switch (event) {
              case 'status':
                callbacks.onStatus(parsed.text ?? parsed.status ?? data);
                break;
              case 'progress': {
                // v847 — strukturiertes Progress-Event
                const evt: ProgressEventDto = {
                  kind: parsed.kind ?? 'status',
                  text: parsed.text ?? '',
                  tool: parsed.tool,
                  toolInput: parsed.toolInput,
                  durationMs: parsed.durationMs,
                  ts: Date.now(),
                };
                if (callbacks.onProgress) callbacks.onProgress(evt);
                else callbacks.onStatus(evt.text); // backwards-compat
                break;
              }
              case 'response':
                callbacks.onResponse(parsed.text ?? data);
                break;
              case 'attachment':
                callbacks.onAttachment(parsed);
                break;
              case 'done':
                callbacks.onDone();
                break;
              case 'error':
                callbacks.onError(parsed.error ?? parsed.message ?? data);
                break;
            }
          } catch {
            // Non-JSON data, treat as text
            if (event === 'response') callbacks.onResponse(data);
            else if (event === 'error') callbacks.onError(data);
          }
        }

        callbacks.onDone();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          callbacks.onError((err as Error).message ?? 'Connection failed');
        }
      }
    })();

    return () => controller.abort();
  }

  async fetchDashboard(
    range?: 'today' | 'week' | 'month' | 'year' | 'all',
    granularity?: 'day' | 'hour',
    date?: string,
  ): Promise<DashboardData> {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (granularity === 'hour') params.set('granularity', 'hour');
    if (date) params.set('date', date);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${this.baseUrl}/api/dashboard${qs}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Dashboard: HTTP ${res.status}`);
    return res.json();
  }

  async fetchHealth(): Promise<HealthData> {
    const res = await fetch(`${this.baseUrl}/api/health`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Health: HTTP ${res.status}`);
    return res.json();
  }

  async fetchKnowledgeGraph(userId?: string): Promise<{ entities: KGEntity[]; relations: KGRelation[] }> {
    const params = userId ? `?userId=${userId}` : '';
    const res = await fetch(`${this.baseUrl}/api/knowledge-graph${params}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`KG: HTTP ${res.status}`);
    return res.json();
  }

  async deleteKgEntity(entityId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/knowledge-graph/entity/${entityId}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  async deleteKgRelation(relationId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/knowledge-graph/relation/${relationId}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  async updateKgEntity(entityId: string, updates: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/knowledge-graph/entity/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  async fetchMemories(type?: string): Promise<MemoryEntry[]> {
    const url = type ? `${this.baseUrl}/api/memories?type=${encodeURIComponent(type)}` : `${this.baseUrl}/api/memories`;
    const res = await fetch(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch memories: ${res.status}`);
    const data = await res.json();
    return data.memories ?? [];
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/memories/${memoryId}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  /** v606 K6 — patch the memory type (for manual reclassification in the UI). */
  async updateMemoryType(memoryId: string, type: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/memories/${memoryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ type }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  async fetchRunbooks(filter?: { status?: string; sourceType?: string }): Promise<Runbook[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.sourceType) params.set('source_type', filter.sourceType);
    const url = `${this.baseUrl}/api/runbooks${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch runbooks: ${res.status}`);
    const data = await res.json();
    return data.runbooks ?? [];
  }

  async fetchRunbook(id: string): Promise<Runbook | null> {
    const res = await fetch(`${this.baseUrl}/api/runbooks/${id}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.runbook ?? null;
  }

  async updateRunbook(id: string, patch: Record<string, unknown>): Promise<Runbook | null> {
    const res = await fetch(`${this.baseUrl}/api/runbooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.runbook ?? null;
  }

  async deleteRunbook(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/runbooks/${id}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // ── v609 — Project-Agent-Sessions ──
  async fetchProjectAgents(filter?: { phase?: string }): Promise<ProjectAgentSession[]> {
    const params = new URLSearchParams();
    if (filter?.phase) params.set('phase', filter.phase);
    const url = `${this.baseUrl}/api/project-agents${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch project agents: ${res.status}`);
    const data = await res.json();
    return data.sessions ?? [];
  }

  async fetchProjectAgent(taskId: string): Promise<ProjectAgentSession | null> {
    const res = await fetch(`${this.baseUrl}/api/project-agents/${taskId}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.session ?? null;
  }

  async stopProjectAgent(taskId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/project-agents/${taskId}/stop`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // v649 — Resume eines fehlgeschlagenen Project-Agent-Laufs
  async resumeProjectAgent(failedTaskId: string, notes?: string): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/project-agents/${failedTaskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ notes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `http-${res.status}` };
    return { ok: true, taskId: data.taskId };
  }

  // v651 — Live-Interjection in laufende Session
  async interjectProjectAgent(taskId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/project-agents/${taskId}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `http-${res.status}` };
    return { ok: true };
  }

  // v651 — SSE-EventSource für Output-Stream. EventSource trägt das auth-token via
  // query-string (?token=…) weil der Browser kein Authorization-Header bei EventSource erlaubt.
  openProjectAgentOutputStream(
    taskId: string,
    onLine: (line: { ts: number; source: string; text: string }) => void,
    onHistory?: (lines: Array<{ ts: number; source: string; text: string }>) => void,
    /** v782 — Optional: strukturierte AgentEvents (für Card-Rendering). */
    onEvent?: (entry: { ts: number; type: string; data: unknown }) => void,
    onEventHistory?: (events: Array<{ ts: number; type: string; data: unknown }>) => void,
  ): EventSource {
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const es = new EventSource(`${this.baseUrl}/api/project-agents/${taskId}/output${qs}`);
    es.addEventListener('line', (ev) => {
      try { onLine(JSON.parse((ev as MessageEvent).data)); } catch { /* skip */ }
    });
    es.addEventListener('history', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        if (onHistory && Array.isArray(payload.lines)) onHistory(payload.lines);
      } catch { /* skip */ }
    });
    // v782 — Strukturierte Events
    es.addEventListener('event', (ev) => {
      try {
        const entry = JSON.parse((ev as MessageEvent).data);
        if (onEvent) onEvent(entry);
      } catch { /* skip */ }
    });
    es.addEventListener('history-events', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        if (onEventHistory && Array.isArray(payload.events)) onEventHistory(payload.events);
      } catch { /* skip */ }
    });
    return es;
  }

  // ── v638 — Insights ──
  async fetchInsights(filter?: { category?: string; status?: string; limit?: number }): Promise<InsightItem[]> {
    const params = new URLSearchParams();
    if (filter?.category) params.set('category', filter.category);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const res = await fetch(`${this.baseUrl}/api/insights${params.toString() ? '?' + params.toString() : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Insights: HTTP ${res.status}`);
    const data = await res.json();
    return data.insights ?? [];
  }
  async fetchInsightsStats(): Promise<Record<string, number>> {
    const res = await fetch(`${this.baseUrl}/api/insights/stats`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Insights-stats: HTTP ${res.status}`);
    const data = await res.json();
    return data.stats ?? {};
  }
  async runInsightsSweep(): Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/insights/sweep`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`Insights-sweep: HTTP ${res.status}`);
    return res.json();
  }
  async dismissInsight(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/insights/${id}/dismiss`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`Dismiss: HTTP ${res.status}`);
  }
  async snoozeInsight(id: string, hours: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/insights/${id}/snooze`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ hours }),
    });
    if (!res.ok) throw new Error(`Snooze: HTTP ${res.status}`);
  }
  // v928 — params: User-Eingaben für Aktionen mit inputFields (z.B. Geburtstag)
  async actOnInsight(id: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: any; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/insights/${id}/act`, {
      method: 'POST',
      headers: params ? this.jsonHeaders : this.authHeaders,
      body: params ? JSON.stringify({ params }) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v928 — Kategorie-Mute („solche Insights nicht mehr")
  async muteInsightCategory(category: string, muted: boolean): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/insights/mute-category`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ category, muted }),
    });
    if (!res.ok) throw new Error(`Mute: HTTP ${res.status}`);
  }
  async fetchMutedInsightCategories(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/insights/muted`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return data.muted ?? [];
  }

  // ── v930 — Interessen-Radar ──
  async fetchInterestTopics(): Promise<InterestTopicItem[]> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Interests: HTTP ${res.status}`);
    const data = await res.json();
    return data.topics ?? [];
  }
  async createInterestTopic(name: string, keywords?: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ name, keywords }),
    });
    if (!res.ok) throw new Error(`Create topic: HTTP ${res.status}`);
  }
  async updateInterestTopic(id: string, patch: { status?: string; notifyThreshold?: string; keywords?: string[] }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics/${id}`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update topic: HTTP ${res.status}`);
  }
  async addInterestSource(topicId: string, data: { kind: 'rss' | 'web_search' | 'youtube'; url?: string; query?: string; channel?: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics/${topicId}/sources`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.reason ?? `Add source: HTTP ${res.status}`);
    }
  }
  async removeInterestSource(topicId: string, sourceId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics/${topicId}/sources/${sourceId}`, {
      method: 'DELETE', headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Remove source: HTTP ${res.status}`);
  }
  async fetchInterestItems(topicId: string, limit = 30): Promise<InterestItemEntry[]> {
    const res = await fetch(`${this.baseUrl}/api/interests/topics/${topicId}/items?limit=${limit}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Items: HTTP ${res.status}`);
    const data = await res.json();
    return data.items ?? [];
  }
  async collectInterestsNow(topicId?: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/interests/collect`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(topicId ? { topicId } : {}),
    });
    if (!res.ok) throw new Error(`Collect: HTTP ${res.status}`);
    const data = await res.json();
    return data.newItems ?? 0;
  }
  // ── v937 — Social ──
  async fetchSocialChannels(): Promise<SocialChannelItem[]> {
    const res = await fetch(`${this.baseUrl}/api/social/channels`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Social: HTTP ${res.status}`);
    return (await res.json()).channels ?? [];
  }
  async updateSocialChannel(id: string, patch: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/social/channels/${id}`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
  }
  async socialPauseAll(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/social/pause-all`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).paused ?? 0;
  }
  async fetchSocialItems(filter?: { channel?: string; status?: string; limit?: number }): Promise<SocialContentItem[]> {
    const params = new URLSearchParams();
    if (filter?.channel) params.set('channel', filter.channel);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const res = await fetch(`${this.baseUrl}/api/social/items${params.toString() ? '?' + params : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Social items: HTTP ${res.status}`);
    return (await res.json()).items ?? [];
  }
  async socialItemAction(id: string, action: 'approve' | 'reject' | 'publish' | 'schedule' | 'edit' | 'delete' | 'remove' | 'revise' | 'regenerate-image' | 'reel', extra?: { scheduled_at?: string; title?: string; body?: string; hashtags?: string[]; lesson?: string; instruction?: string; hint?: string; force?: boolean }): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/items/${id}/${action}`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(extra ?? {}),
    });
    return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  }
  // v992 — Kommentare: Liste + Aktionen (reply geht LIVE auf die Plattform)
  async fetchSocialComments(opts?: { channel?: string; status?: string }): Promise<any[]> {
    const params = new URLSearchParams();
    if (opts?.channel) params.set('channel', opts.channel);
    if (opts?.status) params.set('status', opts.status);
    const res = await fetch(`${this.baseUrl}/api/social/comments${params.toString() ? '?' + params : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Social comments: HTTP ${res.status}`);
    return (await res.json()).comments ?? [];
  }
  async socialCommentAction(id: string, action: 'reply' | 'ignore' | 'suggest', extra?: { reply?: string }): Promise<{ success: boolean; display?: string; error?: string; data?: { draft?: string } }> {
    const res = await fetch(`${this.baseUrl}/api/social/comments/${id}/${action}`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(extra ?? {}),
    });
    return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  }

  // v1015 — Kanal-Wizard: neuen Kanal anlegen (läuft durch den Skill inkl. Leitplanken)
  async socialCreateChannel(payload: { platform: string; name: string; project?: string; mode?: string; publish_mode?: string; persona?: string; config?: Record<string, unknown> }): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/channels`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(payload),
    });
    return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  }

  // v1014 — Bild-Bibliothek: Assets listen + sperren/löschen
  async fetchSocialAssets(): Promise<SocialAssetItem[]> {
    const res = await fetch(`${this.baseUrl}/api/social/assets`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Social assets: HTTP ${res.status}`);
    return (await res.json()).assets ?? [];
  }
  async socialAssetAction(id: string, action: 'block' | 'unblock' | 'delete' | 'motif' | 'describe' | 'pin' | 'unpin', extra?: { motif?: string }): Promise<{ success: boolean; error?: string; motif?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/assets/${id}/${action}`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(extra ?? {}),
    });
    return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  }

  // v966 — Composer: Beitrag anlegen (optional terminieren/sofort posten)
  async socialCreateItem(payload: { channel: string; title?: string; body: string; hashtags?: string[]; media_url?: string; scheduled_at?: string; publish_now?: boolean }): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/items`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Social create: HTTP ${res.status}`);
    return res.json();
  }

  // v966 — Crosspost auf andere Kanäle
  async socialCrosspost(id: string, channels: string[]): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/items/${id}/crosspost`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ channels }),
    });
    if (!res.ok) throw new Error(`Social crosspost: HTTP ${res.status}`);
    return res.json();
  }

  // v1024 — Ad-hoc-Story: Stoff → Beiträge auf allen Familien-Kanälen
  async socialPlanStory(payload: { stoff: string; titel?: string; family?: string }): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/plan-story`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Social plan-story: HTTP ${res.status}`);
    return res.json();
  }

  // v965 — Kanal-Aktionen (Studio-Lauf, Umplanung, Auth-Check, Themen)
  async socialChannelAction(id: string, action: 'generate' | 'replan' | 'validate-auth' | 'link-topic' | 'unlink-topic', extra?: { topic?: string }): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/channels/${id}/${action}`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(extra ?? {}),
    });
    if (!res.ok) throw new Error(`Social channel action: HTTP ${res.status}`);
    return res.json();
  }

  async fetchSocialCalendar(fromIso?: string, toIso?: string): Promise<SocialContentItem[]> {
    const params = new URLSearchParams();
    if (fromIso) params.set('from', fromIso);
    if (toIso) params.set('to', toIso);
    const res = await fetch(`${this.baseUrl}/api/social/calendar${params.toString() ? '?' + params : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Calendar: HTTP ${res.status}`);
    return (await res.json()).items ?? [];
  }
  // v948 — generiertes Bild/Video als Blob-URL (Auth via Bearer, daher kein direktes <img src>)
  async fetchSocialMediaObjectUrl(pathOrUrl: string, width?: number): Promise<string | null> {
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    const basename = pathOrUrl.split(/[\\/]/).pop();
    if (!basename) return null;
    try {
      // v1026 — width lädt ein serverseitig verkleinertes Thumbnail (Galerie)
      const res = await fetch(`${this.baseUrl}/api/social/media/${encodeURIComponent(basename)}${width ? `?w=${width}` : ''}`, { headers: this.authHeaders });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch { return null; }
  }

  // v1026 — Overlays unveröffentlichter Beiträge neu anwenden (nach Look-/Logo-Änderungen)
  async socialRefreshOverlays(channel?: string): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/refresh-overlays`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(channel ? { channel } : {}),
    });
    if (!res.ok) throw new Error(`Social refresh-overlays: HTTP ${res.status}`);
    return res.json();
  }

  // v1039 — Fast-Duplikate der Bild-Bibliothek aufräumen
  async socialDedupLibrary(): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/dedup-library`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) throw new Error(`Social dedup-library: HTTP ${res.status}`);
    return res.json();
  }

  // v1040 — alle Bibliotheks-Beschreibungen per Vision-LLM richtigstellen
  async socialDescribeAssets(): Promise<{ success: boolean; display?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/social/describe-assets`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) throw new Error(`Social describe-assets: HTTP ${res.status}`);
    return res.json();
  }

  // v1041 — Bild (Base64) als gepinnte Termin-Vorlage in die Bibliothek laden
  async socialUploadAsset(dataBase64: string, motif?: string): Promise<{ success: boolean; error?: string; data?: { id: string; basename: string } }> {
    const res = await fetch(`${this.baseUrl}/api/social/assets/upload`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataBase64, ...(motif ? { motif } : {}) }),
    });
    if (!res.ok && res.status !== 400) throw new Error(`Social asset-upload: HTTP ${res.status}`);
    return res.json();
  }

  async fetchSocialMetrics(channelId: string): Promise<Array<{ itemId?: string; date: string; kind: string; value: number }>> {
    const res = await fetch(`${this.baseUrl}/api/social/channels/${channelId}/metrics`, { headers: this.authHeaders });
    if (!res.ok) return [];
    return (await res.json()).metrics ?? [];
  }

  async fetchNotificationSettings(): Promise<NotificationSettings> {
    const res = await fetch(`${this.baseUrl}/api/notifications/settings`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Settings: HTTP ${res.status}`);
    return res.json();
  }
  async updateNotificationSettings(patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const res = await fetch(`${this.baseUrl}/api/notifications/settings`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Settings: HTTP ${res.status}`);
    return res.json();
  }
  // v695 — Bulk-Dismiss aller offenen Insights einer Kategorie (für „kg-gap"-Cleanup)
  async dismissInsightsCategory(category: string): Promise<{ success: boolean; dismissed: number }> {
    const res = await fetch(`${this.baseUrl}/api/insights/dismiss-category`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ category }),
    });
    if (!res.ok) throw new Error(`Bulk-dismiss: HTTP ${res.status}`);
    return res.json();
  }

  // ── v699 — Sandbox (Project-Agent Live-Preview) ──
  async fetchSandboxStatus(): Promise<SandboxStatusResponse> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/status`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-status: HTTP ${res.status}`);
    return res.json();
  }
  async listSandboxes(filter: { projectId?: string; sessionId?: string }): Promise<SandboxItem[]> {
    const params = new URLSearchParams();
    if (filter.projectId) params.set('projectId', filter.projectId);
    if (filter.sessionId) params.set('sessionId', filter.sessionId);
    const res = await fetch(`${this.baseUrl}/api/sandbox/list?${params.toString()}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-list: HTTP ${res.status}`);
    const data = await res.json();
    return data.sandboxes ?? [];
  }
  // v703 — Alle aktiven Sandboxes des Users (für /sandboxes-Sidebar-Seite)
  async listAllSandboxes(): Promise<SandboxItem[]> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/list-all`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-list-all: HTTP ${res.status}`);
    const data = await res.json();
    return data.sandboxes ?? [];
  }
  // v703 — Sandbox-Chat (Interactive-Mode)
  async fetchSandboxChat(sandboxId: string): Promise<SandboxChatItem[]> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/chat`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-chat: HTTP ${res.status}`);
    const data = await res.json();
    return data.messages ?? [];
  }
  // v764 — Project-Wizard API
  async wizardSuggestStack(description: string): Promise<{
    frontend: string; backend: string; database: string; extras: string[]; rationale: string;
  }> {
    const res = await fetch(`${this.baseUrl}/api/projects/wizard/suggest-stack`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ description }),
    });
    if (!res.ok) throw new Error(`wizard-suggest-stack: HTTP ${res.status}`);
    return res.json();
  }
  async wizardGeneratePlan(description: string, stack: {
    frontend: string; backend: string; database: string; extras: string[]; rationale: string;
  }): Promise<{
    items: Array<{ title: string; description?: string; priority: 'low' | 'normal' | 'high'; roadmapMilestone: string; roadmapOrder: number }>;
    decisions: Array<{ choice: string; rationale: string }>;
  }> {
    const res = await fetch(`${this.baseUrl}/api/projects/wizard/generate-plan`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ description, stack }),
    });
    if (!res.ok) throw new Error(`wizard-generate-plan: HTTP ${res.status}`);
    return res.json();
  }
  async wizardValidate(description: string, stack: {
    frontend: string; backend: string; database: string; extras: string[]; rationale: string;
  }, items: Array<{ title: string }>): Promise<{ ok: boolean; issues: string[]; suggestions: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/projects/wizard/validate`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ description, stack, items }),
    });
    if (!res.ok) throw new Error(`wizard-validate: HTTP ${res.status}`);
    return res.json();
  }
  async wizardCreate(input: {
    name: string;
    slug?: string;
    description: string;
    stack: { frontend: string; backend: string; database: string; extras: string[]; rationale: string };
    items: Array<{ title: string; description?: string; priority: 'low' | 'normal' | 'high'; roadmapMilestone: string; roadmapOrder: number }>;
    decisions: Array<{ choice: string; rationale: string }>;
    tags?: string[];
    repoMode?: 'gitlab' | 'github' | 'local';
    scaffoldMode?: 'template' | 'agent' | 'none';
    repoVisibility?: 'private' | 'public';
    runtime?: string;
    deployTarget?: 'static' | 'single' | 'docker' | 'compose' | 'serverless';
  }): Promise<{ ok: boolean; projectId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/wizard/create`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error ?? data.reason ?? `http-${res.status}` };
    return data;
  }

  // v762 — Laufenden Code-Agent-Task stoppen
  async stopSandboxChatTask(sandboxId: string, taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/chat/stop`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ taskId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return data;
  }
  // v771 — Failed/stopped Project-Agent-Task resumen
  async resumeSandboxChatTask(sandboxId: string, taskId: string): Promise<{ ok: boolean; taskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/chat/resume`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ taskId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return data;
  }
  async sendSandboxChatMessage(
    sandboxId: string,
    message: string,
    attachments?: Array<{ name: string; mime: string; dataUrl: string; dropInWorktree: boolean }>,
    mentions?: Array<{ id: string; type: 'open_item' | 'decision'; title: string; priority?: string; status?: string }>,
    engine?: 'project-agent' | 'code-agent' | 'discuss',
    /** v787 — Optional override: welche CLI-Agent (claude-code/vibe/codex/...) für diesen Run. */
    agentName?: string,
  ): Promise<{ ok: boolean; userMessageId?: string; taskId?: string; reason?: string }> {
    const body: Record<string, unknown> = { message };
    if (attachments && attachments.length > 0) body.attachments = attachments;
    if (mentions && mentions.length > 0) body.mentions = mentions;
    if (engine) body.engine = engine;
    if (agentName) body.agentName = agentName;
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/chat`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return data;
  }

  /** v787 — Liste aller registrierten AgentSession-Adapter (claude-code/vibe/codex/generic). */
  async fetchAvailableAgents(): Promise<Array<{ name: string; capabilities: Record<string, unknown> }>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/agent-session/adapters`, { headers: this.authHeaders });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({})) as { adapters?: Array<{ name: string; capabilities: Record<string, unknown> }> };
      return data.adapters ?? [];
    } catch {
      return [];
    }
  }

  /** v791 — Alle persistierten Events einer Session abrufen (für Replay-UI). */
  async fetchAgentSessionEvents(sessionId: string, limit?: number): Promise<Array<{
    id: string;
    iteration: number;
    eventType: string;
    eventData: any;
    createdAt: string;
  }>> {
    try {
      const url = limit
        ? `${this.baseUrl}/api/agent-session/events/${encodeURIComponent(sessionId)}?limit=${limit}`
        : `${this.baseUrl}/api/agent-session/events/${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, { headers: this.authHeaders });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({})) as { events?: Array<any> };
      return data.events ?? [];
    } catch {
      return [];
    }
  }

  /** v789 — Session zurücksetzen: CLI-State + DB-Eintrag löschen. Nächster Run startet frisch. */
  async resetAgentSession(sandboxId: string, agentName: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/agent-session/sessions/${encodeURIComponent(sandboxId)}/${encodeURIComponent(agentName)}`, {
        method: 'DELETE',
        headers: this.authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
      return data;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** v788 — Session-Stats für eine Sandbox (alle aktiven Agents). */
  async fetchAgentSessions(sandboxId: string): Promise<Array<{
    id: string;
    agentName: string;
    cliSessionId?: string;
    status: string;
    messageCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalCachedTokens: number;
    totalCostUsd: number;
    lastHealthOk?: number;
    startedAt: string;
    lastUsedAt: string;
    capabilities?: Record<string, unknown>;
  }>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/agent-session/sessions/${encodeURIComponent(sandboxId)}`, { headers: this.authHeaders });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({})) as { sessions?: Array<any> };
      return data.sessions ?? [];
    } catch {
      return [];
    }
  }
  async getSandbox(sandboxId: string): Promise<SandboxItem | null> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}`, { headers: this.authHeaders });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sandbox-get: HTTP ${res.status}`);
    const data = await res.json();
    return data.sandbox ?? null;
  }
  async createSandbox(input: { projectId: string; sessionId?: string | null; mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat'; slug?: string; envStage?: string; dbSeedId?: string | null }): Promise<SandboxItem> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/create`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Sandbox-create: HTTP ${res.status}`);
    return data.sandbox;
  }
  async pauseSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/pause`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-pause: HTTP ${res.status}`);
  }
  async resumeSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/resume`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-resume: HTTP ${res.status}`);
  }
  async discardSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/discard`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-discard: HTTP ${res.status}`);
  }
  async mergeSandbox(sandboxId: string, opts: { strategy?: 'direct' | 'pr'; commitMessage?: string; prTitle?: string; prBody?: string; confirmDirect?: boolean }): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/merge`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(opts) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async fetchSandboxDiff(sandboxId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/diff`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Sandbox-diff: HTTP ${res.status}`);
    return res.text();
  }
  // v728 — Sandbox-Toolbar-Actions
  async restartSandbox(sandboxId: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/restart`, { method: 'POST', headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v748 — Force-Fail für stuck sandboxes
  async forceFailSandbox(sandboxId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/force-fail`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ reason }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async fetchSandboxLogs(sandboxId: string, tail = 200): Promise<{ ok: boolean; logs?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/logs?tail=${tail}`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async fetchSandboxStats(sandboxId: string): Promise<{ ok: boolean; stats?: { ramMb: number | null; cpuPct: number | null; status: string | null; createdAt: string; hostPort: number | null; image: string }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox/${sandboxId}/stats`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v728 — Environments-CRUD-API
  async fetchEnvironmentStages(projectId: string): Promise<Array<{ stage: string; keyCount: number; updatedAt: string }>> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/environments`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`environments-list: HTTP ${res.status}`);
    const data = await res.json();
    return (data.stages ?? []) as Array<{ stage: string; keyCount: number; updatedAt: string }>;
  }
  async fetchEnvironmentVars(projectId: string, stage: string, reveal = false): Promise<Record<string, string>> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/environments/${encodeURIComponent(stage)}${reveal ? '?reveal=1' : ''}`, { headers: this.authHeaders });
    if (!res.ok) {
      // v907 — klare Backend-Meldung durchreichen (z.B. „Stage … nicht mehr lesbar …")
      // statt nur des HTTP-Codes.
      const data = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(data.error ?? `environments-get: HTTP ${res.status}`);
    }
    const data = await res.json();
    return (data.vars ?? {}) as Record<string, string>;
  }
  async setEnvironmentVars(projectId: string, stage: string, vars: Record<string, string>, replace = false): Promise<{ ok: boolean; count?: number; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/environments/${encodeURIComponent(stage)}`, { method: 'PUT', headers: this.jsonHeaders, body: JSON.stringify({ vars, replace }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async deleteEnvironmentStage(projectId: string, stage: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/environments/${encodeURIComponent(stage)}`, { method: 'DELETE', headers: this.authHeaders });
    if (!res.ok) throw new Error(`environments-delete: HTTP ${res.status}`);
  }
  // v732 — Repo-Scan: schlägt benötigte Keys vor
  async scanEnvironmentRepo(projectId: string): Promise<{ ok: boolean; keys?: Array<{ key: string; sources: string[] }>; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/environments/scan`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }

  // v732 — DB-Seeds API
  async fetchDbSeeds(projectId: string): Promise<Array<{ id: string; name: string; kind: string; storageRef: string; sizeBytes: number; createdAt: string }>> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/db-seeds`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`db-seeds-list: HTTP ${res.status}`);
    const data = await res.json();
    return data.seeds ?? [];
  }
  async uploadDbSeed(projectId: string, name: string, dataUrl: string): Promise<{ ok: boolean; seedId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/db-seeds`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ name, dataUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async registerDbSeedRepoPath(projectId: string, name: string, repoPath: string): Promise<{ ok: boolean; seedId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/db-seeds/repo-path`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ name, repoPath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async setDefaultDbSeed(projectId: string, seedId: string | null): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/db-seeds/default`, {
      method: 'PUT', headers: this.jsonHeaders, body: JSON.stringify({ seedId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async deleteDbSeed(projectId: string, seedId: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/db-seeds/${seedId}`, {
      method: 'DELETE', headers: this.authHeaders,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }

  // v751 — Sandbox-Templates API
  async fetchSandboxTemplates(projectId?: string | null): Promise<Array<{
    id: string;
    projectId?: string | null;
    name: string;
    description?: string;
    mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
    envStage?: string;
    dbSeedId?: string;
    initialGoal?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }>> {
    const params = new URLSearchParams();
    if (projectId !== undefined) params.set('projectId', projectId === null ? '' : projectId);
    const qs = params.toString();
    const res = await fetch(`${this.baseUrl}/api/sandbox-templates${qs ? `?${qs}` : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`sandbox-templates-list: HTTP ${res.status}`);
    const data = await res.json();
    return data.templates ?? [];
  }
  async createSandboxTemplate(input: {
    projectId?: string | null;
    name: string;
    description?: string;
    mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
    envStage?: string;
    dbSeedId?: string;
    initialGoal?: string;
    tags?: string[];
  }): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox-templates`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async updateSandboxTemplate(id: string, patch: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox-templates/${id}`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async deleteSandboxTemplate(id: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/sandbox-templates/${id}`, {
      method: 'DELETE', headers: this.authHeaders,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }

  // v742/v820 — Re-Match Open-Items (considered/candidates/filesUsed kommen aus dem Matcher für sinnvollere UI-Texte)
  async reMatchProjectOpenItems(projectId: string): Promise<{ ok: boolean; matched?: number; resolved?: number; considered?: number; candidates?: number; filesUsed?: number; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/re-match-open-items`, {
      method: 'POST', headers: this.authHeaders,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v797 — Manueller Health-Check-Trigger (statt 6h-Schedule warten)
  async triggerProjectHealthCheck(projectId: string): Promise<{ ok: boolean; probes?: Array<{ probe: string; status: string; details?: string }>; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/health-check`, {
      method: 'POST', headers: this.authHeaders,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v824 — Agent-Conventions API (Phase 1 vollständig, alle 7 Actions)
  async conventionsStatus(projectId: string, packagePath?: string): Promise<{ ok: boolean; data?: AgentConventionsStatus; reason?: string }> {
    const url = `${this.baseUrl}/api/projects/${projectId}/conventions/status${packagePath ? `?package_path=${encodeURIComponent(packagePath)}` : ''}`;
    const res = await fetch(url, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsGenerate(projectId: string, opts?: { packagePath?: string; language?: 'de' | 'en'; tier?: 'fast' | 'default' | 'strong' }): Promise<{ ok: boolean; data?: AgentConventionsGenerateData; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/generate`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsApply(projectId: string, opts?: { packagePath?: string; content?: string; commitToGit?: boolean; outputs?: string[] }): Promise<{ ok: boolean; data?: AgentConventionsApplyData; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/apply`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsRefresh(projectId: string, opts?: { packagePath?: string; language?: 'de' | 'en' }): Promise<{ ok: boolean; data?: AgentConventionsGenerateData; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/refresh`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsDriftCheck(projectId: string, packagePath?: string): Promise<{ ok: boolean; data?: { driftScore: number; reasons: string[]; checkedAt: string }; reason?: string }> {
    const url = `${this.baseUrl}/api/projects/${projectId}/conventions/drift-check${packagePath ? `?package_path=${encodeURIComponent(packagePath)}` : ''}`;
    const res = await fetch(url, { method: 'POST', headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsHistory(projectId: string, packagePath?: string): Promise<{ ok: boolean; data?: { entries: AgentConventionsHistoryEntry[] }; reason?: string }> {
    const url = `${this.baseUrl}/api/projects/${projectId}/conventions/history${packagePath ? `?package_path=${encodeURIComponent(packagePath)}` : ''}`;
    const res = await fetch(url, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsRollback(projectId: string, historyId: string, packagePath?: string): Promise<{ ok: boolean; data?: { rolledBackTo: string; filePath: string }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/rollback`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ historyId, packagePath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v825 — Phase 2 Lessons-Loop API
  async conventionsListLessons(projectId: string, packagePath?: string): Promise<{ ok: boolean; data?: { lessons: AgentConventionsLesson[]; pendingCount: number; appliedCount: number }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/lessons${packagePath ? `?package_path=${encodeURIComponent(packagePath)}` : ''}`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsConsolidateLessons(projectId: string, packagePath?: string): Promise<{ ok: boolean; data?: AgentConventionsGenerateData & { consolidatedLessonsCount: number; autoApplied?: { historyId: string; filePath: string; reason: string }; autoApplyDecision?: string }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/consolidate-lessons`, {
      method: 'POST', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ packagePath: packagePath ?? '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v826 — Phase 3.1 Monorepo + 3.2 Auto-Apply API
  async conventionsListPackages(projectId: string): Promise<{ ok: boolean; data?: { isMonorepo: boolean; workspaceFormat: string; packages: AgentConventionsPackage[] }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/packages`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsGenerateAllPackages(projectId: string): Promise<{ ok: boolean; data?: { packagesProcessed: number; successCount: number; failureCount: number; totalCostUsd: number; perPackage: Array<{ packagePath: string; ok: boolean; reason?: string; costUsd?: number }> }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/generate-all-packages`, {
      method: 'POST', headers: this.authHeaders,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  // v832 — Phase 4.1 Effectiveness + Phase 3.3 Patterns UI
  async conventionsEffectivenessMetrics(projectId: string): Promise<{ ok: boolean; data?: AgentConventionsEffectivenessData; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/effectiveness`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsListPatterns(): Promise<{ ok: boolean; data?: { patterns: AgentConventionsPattern[] }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/conventions/patterns`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsGetConfigOverrides(projectId: string): Promise<{ ok: boolean; data?: { global: Record<string, unknown>; overrides: Record<string, unknown>; effective: Record<string, unknown> }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/config-overrides`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsSetConfigOverrides(projectId: string, overrides: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/config-overrides`, {
      method: 'PUT', headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  async conventionsSectionHealth(projectId: string): Promise<{ ok: boolean; data?: { stats: AgentConventionsSectionHealth[]; suggestedRemoval: AgentConventionsSectionHealth[] }; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/conventions/section-health`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }
  /** Preview-URL: für iframe-src, embed-fähig dank ?_alfred_auth=<token> (setzt Cookie via redirect). */
  buildSandboxPreviewUrl(sandboxId: string): string {
    return `${this.baseUrl}/preview/${sandboxId}/?_alfred_auth=${encodeURIComponent(this.token ?? '')}`;
  }

  // ── v639 — Goals ──
  async fetchGoals(filter?: { status?: string; category?: string }): Promise<GoalItem[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.category) params.set('category', filter.category);
    const res = await fetch(`${this.baseUrl}/api/goals${params.toString() ? '?' + params.toString() : ''}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Goals: HTTP ${res.status}`);
    const data = await res.json();
    return data.goals ?? [];
  }
  async fetchGoalDetail(id: string): Promise<{ goal: GoalItem; checkpoints: GoalCheckpointItem[] } | null> {
    const res = await fetch(`${this.baseUrl}/api/goals/${id}`, { headers: this.authHeaders });
    if (!res.ok) return null;
    return res.json();
  }
  async addGoal(data: Partial<GoalItem>): Promise<GoalItem> {
    const res = await fetch(`${this.baseUrl}/api/goals`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`Goals add: HTTP ${res.status}`);
    return (await res.json()).goal;
  }
  async updateGoal(id: string, data: Partial<GoalItem>): Promise<GoalItem> {
    const res = await fetch(`${this.baseUrl}/api/goals/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`Goals update: HTTP ${res.status}`);
    return (await res.json()).goal;
  }
  async checkGoal(id: string, status: string, notes?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/goals/${id}/check`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ status, notes }),
    });
    if (!res.ok) throw new Error(`Goal check: HTTP ${res.status}`);
  }

  // ── v629 — Confirmations + Reminders Side-Panel ──
  async fetchPendingConfirmations(): Promise<PendingConfirmationItem[]> {
    const res = await fetch(`${this.baseUrl}/api/confirmations/pending`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch confirmations: ${res.status}`);
    const data = await res.json();
    return data.confirmations ?? [];
  }

  async decideConfirmation(id: string, decision: 'approve' | 'reject' | string): Promise<{ ok: boolean; reason?: string }> {
    // v657 — decision kann auch ein custom-extra-action-key sein (z.B. 'cancel_item', 'snooze_24h')
    const res = await fetch(`${this.baseUrl}/api/confirmations/${id}/${decision}`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error ?? `http-${res.status}` };
    return { ok: true };
  }

  // ── v661 — Todos API ──
  async fetchTodos(opts?: { list?: string; includeCompleted?: boolean }): Promise<TodoItem[]> {
    const params = new URLSearchParams();
    if (opts?.list) params.set('list', opts.list);
    if (opts?.includeCompleted) params.set('includeCompleted', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${this.baseUrl}/api/todos${qs}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.todos) ? data.todos : [];
  }
  async addTodo(input: { title: string; description?: string; priority?: string; dueDate?: string; list?: string; projectId?: string }): Promise<TodoItem | null> {
    const res = await fetch(`${this.baseUrl}/api/todos`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.todo ?? null;
  }
  async toggleTodoComplete(id: string, completed: boolean): Promise<TodoItem | null> {
    const res = await fetch(`${this.baseUrl}/api/todos/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify({ completed }) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.todo ?? null;
  }
  async deleteTodo(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/todos/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }
  // v670 — Edit aller Todo-Felder
  async updateTodo(id: string, patch: { title?: string; description?: string | null; priority?: string; dueDate?: string | null; list?: string }): Promise<TodoItem | null> {
    const res = await fetch(`${this.baseUrl}/api/todos/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.todo ?? null;
  }
  // v670 — Arbeitsnotizen / Fortschritte pro Todo
  async fetchTodoNotes(todoId: string): Promise<TodoNote[]> {
    const res = await fetch(`${this.baseUrl}/api/todos/${todoId}/notes`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.notes) ? data.notes : [];
  }
  async addTodoNote(todoId: string, content: string): Promise<TodoNote | null> {
    const res = await fetch(`${this.baseUrl}/api/todos/${todoId}/notes`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ content }) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.note ?? null;
  }
  async deleteTodoNote(noteId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/todos/notes/${noteId}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }
  // v672 — Todo ↔ Note M:N Verknüpfung (User-Notes)
  async fetchTodoLinkedNotes(todoId: string): Promise<NoteItem[]> {
    const res = await fetch(`${this.baseUrl}/api/todos/${todoId}/linked-notes`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.notes) ? data.notes : [];
  }
  async linkTodoNote(todoId: string, noteId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/todos/${todoId}/note-links/${noteId}`, { method: 'POST', headers: this.authHeaders });
    return res.ok;
  }
  async unlinkTodoNote(todoId: string, noteId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/todos/${todoId}/note-links/${noteId}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }
  async fetchNoteLinkedTodos(noteId: string): Promise<TodoItem[]> {
    const res = await fetch(`${this.baseUrl}/api/notes/${noteId}/linked-todos`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.todos) ? data.todos : [];
  }

  // ── v673 — Attachments (Documents, Files, URLs, Uploads) ──
  async fetchAttachments(entityType: 'todo' | 'note', entityId: string): Promise<AttachmentItem[]> {
    const res = await fetch(`${this.baseUrl}/api/${entityType}s/${entityId}/attachments`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.attachments) ? data.attachments : [];
  }
  async addAttachment(entityType: 'todo' | 'note', entityId: string, input: { sourceKind: 'document' | 'file' | 'url' | 'upload'; sourceRef: string; label?: string; mimeType?: string; sizeBytes?: number }): Promise<AttachmentItem | null> {
    const res = await fetch(`${this.baseUrl}/api/${entityType}s/${entityId}/attachments`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.attachment ?? null;
  }
  async deleteAttachment(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }
  async fetchAvailableDocuments(): Promise<Array<{ id: string; filename: string; mimeType?: string; sizeBytes?: number; createdAt: string }>> {
    const res = await fetch(`${this.baseUrl}/api/documents`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.documents) ? data.documents : [];
  }
  async fetchStoredFiles(): Promise<Array<{ key: string; fileName: string; size: number; createdAt: string }>> {
    const res = await fetch(`${this.baseUrl}/api/files`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.files) ? data.files : [];
  }
  async uploadFileBase64(filename: string, mimeType: string, base64Data: string): Promise<{ key: string; fileName: string; size: number; mimeType: string } | null> {
    const res = await fetch(`${this.baseUrl}/api/uploads`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ filename, mimeType, base64Data }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.file ?? null;
  }
  /** v674 — Download-URL für ein FileStore-File. Token wird als query-param mitgegeben damit
   *  <img src=...> / <a href=...> ohne extra-headers funktionieren. */
  fileDownloadUrl(key: string): string {
    const qs = new URLSearchParams({ key });
    if (this.token) qs.set('token', this.token);
    return `${this.baseUrl}/api/files/download?${qs.toString()}`;
  }

  // ── v661 — Notes API ──
  async fetchNotes(opts?: { query?: string; limit?: number }): Promise<NoteItem[]> {
    const params = new URLSearchParams();
    if (opts?.query) params.set('q', opts.query);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${this.baseUrl}/api/notes${qs}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.notes) ? data.notes : [];
  }
  async addNote(input: { title: string; content: string }): Promise<NoteItem | null> {
    const res = await fetch(`${this.baseUrl}/api/notes`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.note ?? null;
  }
  async updateNote(id: string, input: { title?: string; content?: string }): Promise<NoteItem | null> {
    const res = await fetch(`${this.baseUrl}/api/notes/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(input) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.note ?? null;
  }
  async deleteNote(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/notes/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }

  async fetchPendingReminders(): Promise<ReminderListItem[]> {
    const res = await fetch(`${this.baseUrl}/api/reminders`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch reminders: ${res.status}`);
    const data = await res.json();
    return data.reminders ?? [];
  }

  // ── v627 — Conversation History ──
  async fetchConversations(filter?: { platform?: string; limit?: number; offset?: number; sort?: string; since?: string; until?: string; includeDeleted?: boolean }): Promise<ConversationSummaryItem[]> {
    const params = new URLSearchParams();
    if (filter?.platform) params.set('platform', filter.platform);
    if (filter?.limit) params.set('limit', String(filter.limit));
    if (filter?.offset) params.set('offset', String(filter.offset));
    if (filter?.sort) params.set('sort', filter.sort);
    if (filter?.since) params.set('since', filter.since);
    if (filter?.until) params.set('until', filter.until);
    if (filter?.includeDeleted) params.set('include_deleted', '1');
    const url = `${this.baseUrl}/api/conversations${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new Error(`Failed to fetch conversations: ${res.status}`);
    const data = await res.json();
    return data.conversations ?? [];
  }

  async fetchConversationMessages(id: string, opts?: { beforeIso?: string; limit?: number }): Promise<ConversationMessageItem[]> {
    const params = new URLSearchParams();
    if (opts?.beforeIso) params.set('before', opts.beforeIso);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const url = `${this.baseUrl}/api/conversations/${id}/messages${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
    const data = await res.json();
    return data.messages ?? [];
  }

  async fetchConversationSummary(id: string): Promise<ConversationSummary | null> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${id}/summary`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.summary ?? null;
  }

  async searchConversations(query: string, limit = 30): Promise<ConversationSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const res = await fetch(`${this.baseUrl}/api/conversations/search?${params.toString()}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const data = await res.json();
    return data.results ?? [];
  }

  // v644 — Conversation Lifecycle
  async patchConversation(id: string, patch: { customLabel?: string | null; pinned?: boolean }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Patch: HTTP ${res.status}`);
  }
  async deleteConversation(id: string, hard = false): Promise<void> {
    const qs = hard ? '?hard=1' : '';
    const res = await fetch(`${this.baseUrl}/api/conversations/${id}${qs}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Delete: HTTP ${res.status}`);
  }
  async branchConversation(id: string, atMessageId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${id}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ at_message_id: atMessageId }),
    });
    if (!res.ok) throw new Error(`Branch: HTTP ${res.status}`);
    const data = await res.json();
    return data.newConversationId;
  }
  async exportConversations(ids: string[]): Promise<{ entries: Array<{ id: string; filename: string; content: string }> }> {
    const res = await fetch(`${this.baseUrl}/api/conversations/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ conversation_ids: ids }),
    });
    if (!res.ok) throw new Error(`Export: HTTP ${res.status}`);
    return res.json();
  }
  async replayToolCall(conversationId: string, messageId: string): Promise<{ ok: boolean; reason?: string; result?: any }> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${conversationId}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ message_id: messageId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
  }

  // v644 — Audio Transcription
  async transcribeAudio(blob: Blob): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'audio/webm',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: blob,
    });
    if (!res.ok) throw new Error(`Transcribe: HTTP ${res.status}`);
    const data = await res.json();
    return data.text ?? '';
  }

  // ── v623 — Background-Tasks ──
  async fetchBackgroundTasks(filter?: { status?: string }): Promise<BackgroundTaskItem[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    const url = `${this.baseUrl}/api/background-tasks${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Failed to fetch background tasks: ${res.status}`);
    const data = await res.json();
    return data.tasks ?? [];
  }

  async fetchBackgroundTask(id: string): Promise<BackgroundTaskItem | null> {
    const res = await fetch(`${this.baseUrl}/api/background-tasks/${id}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.task ?? null;
  }

  async cancelBackgroundTask(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/background-tasks/${id}/cancel`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // ── Projects API ──
  async fetchProjects(filter?: { status?: string }): Promise<Project[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    const url = `${this.baseUrl}/api/projects${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
    const data = await res.json();
    return data.projects ?? [];
  }

  async fetchProject(id: string): Promise<ProjectDetail | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) return null;
    return await res.json();
  }

  // v658 — Work-Stats pro Projekt
  async fetchProjectWorkStats(projectId: string): Promise<ProjectWorkStats | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/work-stats`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) return null;
    return await res.json();
  }

  // v866 — Globale CLI-Agent-Usage (eigene Subscriptions/Keys, getrennt vom Alfred-Usage-Tracking)
  async fetchCliUsage(days?: number): Promise<CliUsageOverview | null> {
    const qs = days && days > 0 ? `?days=${days}` : '';
    const res = await fetch(`${this.baseUrl}/api/cli-usage${qs}`, { headers: this.authHeaders });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.totals ? data as CliUsageOverview : null;
  }

  // v847 — Chat-Actions: Liste pro Projekt + Detail
  async fetchProjectChatActions(projectId: string, limit = 50): Promise<ChatActionDto[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/chat-actions?limit=${limit}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.actions) ? data.actions : [];
  }
  async fetchChatAction(actionId: string): Promise<ChatActionDto | null> {
    const res = await fetch(`${this.baseUrl}/api/chat-actions/${actionId}`, { headers: this.authHeaders });
    if (!res.ok) return null;
    return await res.json();
  }

  // v851 — Feature-Library
  async fetchProjectFeatures(projectId: string, status?: string): Promise<ProjectFeatureDto[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/features${qs}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.features) ? data.features : [];
  }
  async searchFeatures(query: string, limit = 10): Promise<ProjectFeatureDto[]> {
    const res = await fetch(`${this.baseUrl}/api/features/search?q=${encodeURIComponent(query)}&limit=${limit}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.features) ? data.features : [];
  }
  async setFeatureVisibility(featureId: string, visibility: 'private' | 'role-shared' | 'global'): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/features/${featureId}/visibility`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify({ visibility }),
    });
    return res.ok;
  }
  async confirmFeature(featureId: string, action: 'confirm' | 'reject'): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/features/${featureId}/${action}`, {
      method: 'POST', headers: this.authHeaders,
    });
    return res.ok;
  }
  async retireFeature(featureId: string, reason?: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/features/${featureId}`, {
      method: 'DELETE', headers: this.jsonHeaders, body: JSON.stringify({ reason }),
    });
    return res.ok;
  }

  // v665b — Cluster-Shares + Project-Move
  async fetchClusterShares(): Promise<ClusterShareStatus[]> {
    const res = await fetch(`${this.baseUrl}/api/cluster/shares`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return data.shares ?? [];
  }
  async projectMovePreflight(projectId: string, target: { storageType: 'local' | 'shared'; shareId?: string; nodeId?: string }): Promise<MovePreflightResult> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/move/preflight`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(target),
    });
    if (!res.ok) return { ok: false, checks: [] };
    return await res.json();
  }
  async projectMove(projectId: string, target: { storageType: 'local' | 'shared'; shareId?: string; nodeId?: string }, opts?: { excludes?: string[]; keepSource?: boolean }): Promise<MoveResult> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/move`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ ...target, ...(opts ?? {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  }

  // v663b — Automations API
  async fetchAutomationTemplates(): Promise<AutomationTemplate[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/automation-templates`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return data.templates ?? [];
  }
  async fetchProjectAutomations(projectId: string): Promise<ProjectAutomation[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/automations`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return data.automations ?? [];
  }
  async addProjectAutomation(projectId: string, input: Partial<ProjectAutomation>): Promise<ProjectAutomation | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/automations`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.automation ?? null;
  }
  async updateProjectAutomation(id: string, patch: Partial<ProjectAutomation>): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/automations/${id}`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    return res.ok;
  }
  async deleteProjectAutomation(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/automations/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }
  async runProjectAutomation(id: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/automations/${id}/run`, { method: 'POST', headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  }

  // v663a — Roadmap-API
  async fetchProjectRoadmap(projectId: string): Promise<Record<string, ProjectOpenItem[]>> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/roadmap`, { headers: this.authHeaders });
    if (!res.ok) return {};
    const data = await res.json();
    return data.milestones ?? {};
  }
  async updateOpenItemRoadmap(itemId: string, patch: { milestone?: string | null; order?: number | null; estimatedHours?: number | null }): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/open-items/${itemId}/roadmap`, {
      method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(patch),
    });
    return res.ok;
  }
  async implementMilestone(projectId: string, milestone: string): Promise<{ ok: boolean; taskId?: string; itemCount?: number; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/implement-milestone`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ milestone }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  }

  // v659 — Letzte Deploys aus deploy_*-Memory + auto-detected Runtime aus cwd
  async fetchProjectLastDeploys(projectId: string): Promise<{ deploys: ProjectLastDeploy[]; detectedRuntime?: string; detectionReason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/last-deploys`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) return { deploys: [] };
    const data = await res.json();
    return {
      deploys: Array.isArray(data.deploys) ? data.deploys : [],
      detectedRuntime: typeof data.detectedRuntime === 'string' ? data.detectedRuntime : undefined,
      detectionReason: typeof data.detectionReason === 'string' ? data.detectionReason : undefined,
    };
  }

  // v659 — Deploy-Trigger mit Form-Params
  async triggerProjectDeploy(projectId: string, input: {
    host: string; user?: string; process_manager?: string; runtime?: string;
    app_port?: number; branch?: string; repo_url?: string;
    install_command?: string; build_command?: string; start_command?: string;
    env_stage?: string; skip_env?: boolean;
    /** v840 — Wenn gesetzt: Backend emittet Live-Step-Events via SSE-Stream
     *  /api/project-agents/<taskId>/output. Frontend muss VOR dem POST den Stream
     *  öffnen damit keine Events verloren gehen (Stream cached aber 5min). */
    progressTaskId?: string;
  }): Promise<{ success: boolean; data?: unknown; error?: string; display?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  }

  // v658 — Chat-History für Projekt-Conversation
  async fetchProjectChatHistory(projectId: string, limit = 100): Promise<ProjectChatHistory | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/chat-history?limit=${limit}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) return null;
    return await res.json();
  }

  // v658 — Stream-Message mit projectId für Projekt-Chat
  streamProjectMessage(
    projectId: string,
    text: string,
    userId: string,
    callbacks: StreamCallbacks,
    replyTo?: { messageId?: string; text?: string; from?: string },
    /** v687 — Context-Refs (Open-Items, Notes, Documents, Files) die per Toolbar/@-Mention angefügt wurden */
    contextRefs?: Array<{ kind: string; refId: string; label?: string }>,
    /** v890 — CLI-Wahl des Projekt-Chat-Pickers ('auto' = Projekt-Strategie, sonst konkrete CLI) */
    agentChoice?: string,
  ): () => void {
    const controller = new AbortController();
    (async () => {
      try {
        const body: Record<string, unknown> = { text, userId, projectId };
        if (replyTo?.text) {
          body.replyToText = replyTo.text;
          if (replyTo.from) body.replyToFrom = replyTo.from;
          if (replyTo.messageId) body.replyToMessageId = replyTo.messageId;
        }
        if (contextRefs && contextRefs.length > 0) {
          body.contextRefs = contextRefs;
        }
        if (agentChoice && agentChoice.length > 0) {
          body.agentChoice = agentChoice;
        }
        const res = await fetch(`${this.baseUrl}/api/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) { callbacks.onError(`HTTP ${res.status}: ${res.statusText}`); return; }
        for await (const { event, data } of readSseStream(res)) {
          try {
            const parsed = JSON.parse(data);
            switch (event) {
              case 'status': callbacks.onStatus(parsed.text ?? parsed.status ?? data); break;
              case 'progress': {
                // v847.1 — strukturiertes Progress-Event (war v847 nur in streamMessage,
                // hier vergessen). Ohne diesen case bleibt statusLog leer und der User
                // sieht nur das initial "Sende an Alfred…".
                const evt: ProgressEventDto = {
                  kind: parsed.kind ?? 'status',
                  text: parsed.text ?? '',
                  tool: parsed.tool,
                  toolInput: parsed.toolInput,
                  durationMs: parsed.durationMs,
                  ts: Date.now(),
                };
                if (callbacks.onProgress) callbacks.onProgress(evt);
                else callbacks.onStatus(evt.text);
                break;
              }
              case 'response': callbacks.onResponse(parsed.text ?? data); break;
              case 'attachment': callbacks.onAttachment(parsed); break;
              case 'done': callbacks.onDone(); break;
              case 'error': callbacks.onError(parsed.error ?? parsed.message ?? data); break;
            }
          } catch {
            if (event === 'response') callbacks.onResponse(data);
            else if (event === 'error') callbacks.onError(data);
          }
        }
        callbacks.onDone();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') callbacks.onError((err as Error).message ?? 'Connection failed');
      }
    })();
    return () => controller.abort();
  }

  async createProject(input: { name: string; description?: string; cwd?: string; repoUrl?: string; tags?: string[] }): Promise<Project | null> {
    const res = await fetch(`${this.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.project ?? null;
  }

  async updateProject(id: string, patch: Record<string, unknown>): Promise<Project | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.project ?? null;
  }

  async archiveProject(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}`, {
      method: 'DELETE',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  async addProjectOpenItem(projectId: string, input: { title: string; description?: string; priority?: string }): Promise<ProjectOpenItem | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/open-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.item ?? null;
  }

  /** v815 P1 — manuelle Decision-Erstellung (vorher: nur via Session-Summary). */
  async addProjectDecision(projectId: string, input: { title: string; choice: string; rationale?: string }): Promise<{ id: string; title: string; choice: string; rationale?: string } | null> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.decision ?? null;
  }

  async updateProjectOpenItem(itemId: string, status: 'open' | 'in_progress' | 'done' | 'cancelled'): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/open-items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // v704 — Open-Item title/description editieren
  async patchProjectOpenItem(itemId: string, patch: { title?: string; description?: string | null; status?: string; depends_on?: string[] | null }): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/projects/open-items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // v641 — Bulk-Work + Audit für Open-Items
  async projectWorkOnOpenItems(projectId: string, itemIds: string[], maxItems = 10): Promise<{ ok: boolean; taskId?: string; mode?: string; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/work-on-items`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ item_ids: itemIds, max_items: maxItems }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error ?? data.reason ?? `http-${res.status}` };
    // v869.3 — mode 'code' liefert liveTaskId fürs Live-Output-Panel
    return { ok: true, taskId: data.taskId, mode: data.mode, liveTaskId: data.liveTaskId };
  }

  // v870 — Deep-Verify: read-only Codebase-Prüfung (markierte oder alle offenen Items)
  async projectDeepVerify(projectId: string, itemIds?: string[], maxItems = 15): Promise<{ ok: boolean; liveTaskId?: string; itemCount?: number; skippedForCap?: number; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/deep-verify`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ item_ids: itemIds && itemIds.length > 0 ? itemIds : undefined, max_items: maxItems }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId, itemCount: data.itemCount, skippedForCap: data.skippedForCap };
  }

  async projectDeepVerifyResult(taskId: string): Promise<{ status: 'running' | 'done' | 'failed' | 'unknown'; findings?: Array<{ id: string; verdict: 'implemented' | 'partially' | 'not-implemented' | 'obsolete'; confidence: number; evidence: string; missing?: string }>; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/deep-verify/${taskId}/result`, { headers: this.authHeaders });
    if (!res.ok) return { status: 'unknown' };
    return await res.json();
  }

  async projectAuditOpenItems(projectId: string): Promise<{ data?: any; display?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/audit-items`, {
      method: 'POST', headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Audit: HTTP ${res.status}`);
    return res.json();
  }

  async projectBulkCloseItems(projectId: string, itemIds: string[]): Promise<{ closed: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/bulk-close-items`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ item_ids: itemIds }),
    });
    if (!res.ok) throw new Error(`Bulk-Close: HTTP ${res.status}`);
    return res.json();
  }

  // v643 — Commits per Project / Session
  async fetchProjectCommits(projectId: string, limit = 100): Promise<ProjectCommit[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/commits?limit=${limit}`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return data.commits ?? [];
  }
  async fetchSessionCommits(projectId: string, sessionId: string): Promise<ProjectCommit[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/sessions/${sessionId}/commits`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    return data.commits ?? [];
  }

  async fetchProjectHealthLog(id: string, limit = 100): Promise<ProjectHealthEntry[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/health-log?limit=${limit}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries ?? [];
  }

  /** v872 — Repo-Status-Karte: frischer Git-Zustand (nicht der 6h-Health-Cache). */
  async fetchProjectRepoStatus(id: string): Promise<ProjectRepoStatus | { error: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/repo-status`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({ error: `http-${res.status}` }));
    if (!res.ok) return { error: data.error ?? `http-${res.status}` };
    return data as ProjectRepoStatus;
  }

  /** v872 — CI-Pipeline-Status des aktuellen Branches je Forge-Provider. */
  async fetchProjectPipelineStatus(id: string): Promise<{ pipelines: ProjectPipelineInfo[]; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/pipeline-status`, { headers: this.authHeaders });
    if (!res.ok) return { pipelines: [], reason: `http-${res.status}` };
    const data = await res.json().catch(() => ({ pipelines: [] }));
    return { pipelines: data.pipelines ?? [], reason: data.reason };
  }

  /** v875 — Wochen-Budget-Status (Soft-Budget + CLI-Kosten der letzten 7 Tage). */
  async fetchProjectBudget(id: string): Promise<{ budgetWeeklyUsd: number | null; spent7dUsd: number; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/budget`, { headers: this.authHeaders });
    if (!res.ok) return { budgetWeeklyUsd: null, spent7dUsd: 0, error: `http-${res.status}` };
    return res.json().catch(() => ({ budgetWeeklyUsd: null, spent7dUsd: 0 }));
  }

  /** v874 — offene MRs/PRs des Projekts je Forge-Provider. */
  async fetchProjectMergeRequests(id: string): Promise<{ mergeRequests: ProjectMergeRequest[]; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/merge-requests`, { headers: this.authHeaders });
    if (!res.ok) return { mergeRequests: [], reason: `http-${res.status}` };
    const data = await res.json().catch(() => ({ mergeRequests: [] }));
    return { mergeRequests: data.mergeRequests ?? [], reason: data.reason };
  }

  /** v873 — Docs-Tab: Markdown-Dateien des Projekt-CWDs. */
  async fetchProjectDocs(id: string): Promise<{ files: ProjectDocFile[]; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/docs`, { headers: this.authHeaders });
    if (!res.ok) return { files: [], error: `http-${res.status}` };
    const data = await res.json().catch(() => ({ files: [] }));
    return { files: data.files ?? [], error: data.error };
  }

  async fetchProjectDocContent(id: string, path: string): Promise<{ path?: string; content?: string; truncated?: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/docs/content?path=${encodeURIComponent(path)}`, { headers: this.authHeaders });
    const data = await res.json().catch(() => ({ error: `http-${res.status}` }));
    if (!res.ok) return { error: data.error ?? `http-${res.status}` };
    return data;
  }

  /** v873 — Dependency-Panel: strukturierte Outdated-Liste. */
  async fetchProjectDepsStatus(id: string): Promise<{ manifest: string | null; deps: ProjectOutdatedDep[]; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/deps-status`, { headers: this.authHeaders });
    if (!res.ok) return { manifest: null, deps: [], error: `http-${res.status}` };
    const data = await res.json().catch(() => ({ manifest: null, deps: [] }));
    return { manifest: data.manifest ?? null, deps: data.deps ?? [], error: data.error };
  }

  /** v879 — konfigurierte CLI-Agents (für Agent-Auswahl im Review-Dialog). */
  async fetchCodeAgents(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/code-agents`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({ agents: [] }));
    return data.agents ?? [];
  }

  /** v889b — welche CLI-Agents gerade in welchem Projekt laufen (für Busy-Badge). */
  async fetchAgentBusy(): Promise<Array<{ cli: string; projectId: string; kind: string }>> {
    const res = await fetch(`${this.baseUrl}/api/projects/agent-busy`, { headers: this.authHeaders });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({ busy: [] }));
    return data.busy ?? [];
  }

  /** v879 — Codebase-Review starten (async, optional Gegenprüfung durch andere Agents). */
  async projectReviewCodebase(id: string, opts?: { scope?: string; reviewAgent?: string; crossCheckAgents?: string[] }): Promise<{ ok: boolean; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/review`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ scope: opts?.scope, review_agent: opts?.reviewAgent, cross_check_agents: opts?.crossCheckAgents }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId };
  }

  async projectReviewResult(taskId: string): Promise<{ status: 'running' | 'done' | 'failed' | 'unknown'; findings?: CodebaseReviewFinding[]; reviewAgent?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/review/${taskId}/result`, { headers: this.authHeaders });
    if (!res.ok) return { status: 'unknown' };
    return res.json().catch(() => ({ status: 'unknown' }));
  }

  /** v880 — Feature-Discovery starten (1-2 Agents, async). */
  async projectSuggestFeatures(id: string, opts?: { focus?: string; agents?: string[] }): Promise<{ ok: boolean; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/suggest-features`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ focus: opts?.focus, agents: opts?.agents }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId };
  }

  async projectSuggestResult(taskId: string): Promise<{ status: 'running' | 'done' | 'failed' | 'unknown'; suggestions?: FeatureSuggestionItem[]; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/suggest/${taskId}/result`, { headers: this.authHeaders });
    if (!res.ok) return { status: 'unknown' };
    return res.json().catch(() => ({ status: 'unknown' }));
  }

  /** v880 — Entscheidung pro Vorschlag: reject → Library, accept → Plan-Lauf (liveTaskId). */
  async projectFeatureDecision(id: string, opts: { title: string; description?: string; decision: 'accept' | 'reject'; agent?: string }): Promise<{ ok: boolean; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/feature-decision`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId };
  }

  /** v897 — Mehrere zusammengehörige Facetten zu EINEM konsolidierten Plan/Milestone. */
  async projectPlanFeaturesCombined(id: string, opts: { features: Array<{ title: string; description?: string }>; name?: string; agent?: string }): Promise<{ ok: boolean; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/plan-features-combined`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId };
  }

  /** v898 — Bestehende Roadmap-Milestones nachträglich zu EINEM Feature zusammenführen (Re-Tag). */
  async projectConsolidateMilestones(id: string, opts: { milestones: string[]; name?: string; agent?: string; withPlan?: boolean }): Promise<{ ok: boolean; liveTaskId?: string; milestone?: string; retagged?: number; planned?: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/consolidate-milestones`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId, milestone: data.milestone, retagged: data.retagged, planned: data.planned };
  }

  /** v873 — Dependency-Update-Lauf starten (async Code-Agent, liveTaskId für SSE-Panel). */
  async projectUpdateDeps(id: string, packages?: string[]): Promise<{ ok: boolean; liveTaskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${id}/update-deps`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ packages: packages && packages.length > 0 ? packages : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? data.error ?? `http-${res.status}` };
    return { ok: true, liveTaskId: data.liveTaskId };
  }

  async updateKgRelation(relationId: string, updates: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/knowledge-graph/relation/${relationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success;
  }

  // ── CMDB API ──

  private get authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }
  private get jsonHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...this.authHeaders };
  }

  async cmdbListAssets(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/cmdb/assets${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbGetAsset(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/assets/${id}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbCreateAsset(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/assets`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbUpdateAsset(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/assets/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbDeleteAsset(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/assets/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }

  async cmdbListRelations(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/relations`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbCreateRelation(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/relations`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbDeleteRelation(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/relations/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }

  async cmdbDiscover(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/discover`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbGetStats(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/stats`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`CMDB: HTTP ${res.status}`);
    return res.json();
  }

  // ── ITSM API ──

  async itsmListIncidents(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmGetIncident(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents/${id}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmCreateIncident(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmUpdateIncident(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmListChanges(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/itsm/changes${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmCreateChange(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/changes`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmUpdateChange(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/changes/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmListServices(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/itsm/services${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmCreateService(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmUpdateService(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmHealthCheck(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/health-check`, { method: 'POST', headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmDashboard(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/dashboard`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  // ── Problem Management API ──

  async itsmListProblems(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/itsm/problems${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmCreateProblem(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmUpdateProblem(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmLinkIncidentToProblem(problemId: string, incidentId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/${problemId}/link-incident`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ incident_id: incidentId }) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmUnlinkIncidentFromProblem(problemId: string, incidentId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/${problemId}/link-incident/${incidentId}`, { method: 'DELETE', headers: this.authHeaders });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmDetectPatterns(windowDays?: number, minIncidents?: number): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/detect-patterns`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ window_days: windowDays, min_incidents: minIncidents }) });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  // v632 — Bulk-Merge + Backfill
  async itsmBulkLinkToProblem(problemId: string, incidentIds: string[]): Promise<{ linked: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/${problemId}/bulk-link`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ incident_ids: incidentIds }),
    });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmPromoteIncidents(title: string, incidentIds: string[], priority?: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/promote`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ title, priority, incident_ids: incidentIds }),
    });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  async itsmBackfillAssets(): Promise<{ updated: number; skipped: number; unmatched: number; total: number }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents/backfill-assets`, {
      method: 'POST', headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`ITSM: HTTP ${res.status}`);
    return res.json();
  }

  // v645 — Generic Bulk-Actions
  async itsmBulkIncidents(ids: string[], action: string, params?: Record<string, unknown>): Promise<{ ok: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/incidents/bulk`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ ids, action, params }),
    });
    if (!res.ok) throw new Error(`ITSM bulk: HTTP ${res.status}`);
    return res.json();
  }
  async itsmBulkChanges(ids: string[], action: string, params?: Record<string, unknown>): Promise<{ ok: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/changes/bulk`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ ids, action, params }),
    });
    if (!res.ok) throw new Error(`ITSM bulk: HTTP ${res.status}`);
    return res.json();
  }
  async itsmBulkProblems(ids: string[], action: string, params?: Record<string, unknown>): Promise<{ ok: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/problems/bulk`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ ids, action, params }),
    });
    if (!res.ok) throw new Error(`ITSM bulk: HTTP ${res.status}`);
    return res.json();
  }
  async itsmBulkServices(ids: string[], action: string, params?: Record<string, unknown>): Promise<{ ok: number; failed: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/bulk`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ ids, action, params }),
    });
    if (!res.ok) throw new Error(`ITSM bulk: HTTP ${res.status}`);
    return res.json();
  }

  // ── v922: SLA + Analytics + Service-Komposition (vorher chat-only) ──

  async slaCompliance(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sla/compliance`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`SLA: HTTP ${res.status}`);
    return res.json();
  }

  async slaBreaches(period?: string): Promise<any[]> {
    const params = period ? `?period=${encodeURIComponent(period)}` : '';
    const res = await fetch(`${this.baseUrl}/api/sla/breaches${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`SLA: HTTP ${res.status}`);
    return res.json();
  }

  async slaSet(targetType: 'service' | 'asset', targetId: string, sla: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sla/set`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ targetType, targetId, sla }),
    });
    if (!res.ok) throw new Error(`SLA: HTTP ${res.status}`);
    return res.json();
  }

  /** kind: mttr | capacity | health | cascades | breach_risk | pir */
  async itsmAnalytics(kind: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/analytics?kind=${encodeURIComponent(kind)}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Analytics: HTTP ${res.status}`);
    return res.json();
  }

  async serviceAddComponent(serviceId: string, component: { name: string; role?: string; assetId?: string; required?: boolean }): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/services/${serviceId}/components`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(component),
    });
    if (!res.ok) throw new Error(`Service-Component: HTTP ${res.status}`);
    return res.json();
  }

  async serviceRemoveComponent(serviceId: string, componentName: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/services/${serviceId}/components/${encodeURIComponent(componentName)}`, {
      method: 'DELETE', headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Service-Component: HTTP ${res.status}`);
    return res.json();
  }

  async serviceAddFailureMode(serviceId: string, fm: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/services/${serviceId}/failure-modes`, {
      method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(fm),
    });
    if (!res.ok) throw new Error(`Failure-Mode: HTTP ${res.status}`);
    return res.json();
  }

  async serviceRemoveFailureMode(serviceId: string, name: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/services/${serviceId}/failure-modes/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failure-Mode: HTTP ${res.status}`);
    return res.json();
  }

  async serviceImpact(serviceId: string): Promise<{ service: string; impact: Array<{ id: string; name: string; criticality?: string }>; failureModes: any[] }> {
    const res = await fetch(`${this.baseUrl}/api/services/${serviceId}/impact`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Impact: HTTP ${res.status}`);
    return res.json();
  }

  // ── Docs API ──

  async docsGenerate(type: string, params?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/docs/generate`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ type, ...params }) });
    if (!res.ok) throw new Error(`Docs: HTTP ${res.status}`);
    return res.json();
  }

  async docsExport(format?: string): Promise<any> {
    const params = format ? `?format=${format}` : '';
    const res = await fetch(`${this.baseUrl}/api/docs/export${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Docs: HTTP ${res.status}`);
    return res.json();
  }

  async fetchDocTree(): Promise<import('@/types/api').DocTree> {
    const res = await fetch(`${this.baseUrl}/api/docs/tree`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Docs: HTTP ${res.status}`);
    return res.json();
  }

  async fetchDoc(id: string): Promise<import('@/types/api').DocDetail> {
    const res = await fetch(`${this.baseUrl}/api/docs/${id}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Doc: HTTP ${res.status}`);
    return res.json();
  }

  async fetchDocVersions(id: string): Promise<import('@/types/api').DocDetail[]> {
    const res = await fetch(`${this.baseUrl}/api/docs/${id}/versions`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Versions: HTTP ${res.status}`);
    return res.json();
  }

  async createDoc(data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/docs`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`Create: HTTP ${res.status}`);
    return res.json();
  }

  async updateDoc(id: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/docs/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`Update: HTTP ${res.status}`);
    return res.json();
  }

  async deleteDoc(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/docs/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }

  async searchDocs(query: string): Promise<import('@/types/api').DocDetail[]> {
    const res = await fetch(`${this.baseUrl}/api/docs/search?q=${encodeURIComponent(query)}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Search: HTTP ${res.status}`);
    return res.json();
  }

  // ── Documents Archive API ──

  async cmdbListDocuments(filters?: Record<string, string>): Promise<any[]> {
    const params = filters ? '?' + new URLSearchParams(filters).toString() : '';
    const res = await fetch(`${this.baseUrl}/api/cmdb/documents${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Docs: HTTP ${res.status}`);
    return res.json();
  }

  async cmdbGetDocument(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/cmdb/documents/${id}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Docs: HTTP ${res.status}`);
    return res.json();
  }

  // ── Log Viewer API ──

  async fetchLogs(options?: { lines?: number; level?: string; filter?: string; fileIndex?: number; since?: number; offset?: number }): Promise<import('@/types/api').LogResponse> {
    const params = new URLSearchParams();
    if (options?.lines) params.set('lines', String(options.lines));
    if (options?.level) params.set('level', options.level);
    if (options?.filter) params.set('filter', options.filter);
    if (options?.fileIndex !== undefined) params.set('file', String(options.fileIndex));
    if (options?.since !== undefined) params.set('since', String(options.since));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const qs = params.toString() ? `?${params}` : '';
    const res = await fetch(`${this.baseUrl}/api/logs/app${qs}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Logs: HTTP ${res.status}`);
    return res.json();
  }

  async fetchAuditLogs(lines?: number, fileIndex?: number, opts?: { since?: number; offset?: number }): Promise<import('@/types/api').LogResponse> {
    const params = new URLSearchParams();
    if (lines) params.set('lines', String(lines));
    if (fileIndex !== undefined) params.set('file', String(fileIndex));
    if (opts?.since !== undefined) params.set('since', String(opts.since));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString() ? `?${params}` : '';
    const res = await fetch(`${this.baseUrl}/api/logs/audit${qs}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`AuditLogs: HTTP ${res.status}`);
    return res.json();
  }

  streamLogs(
    onLine: (entry: import('@/types/api').LogEntry) => void,
    options?: { level?: string; filter?: string },
  ): () => void {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (options?.level) params.set('level', options.level);
    if (options?.filter) params.set('filter', options.filter);
    const qs = params.toString() ? `?${params}` : '';

    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/logs/app/stream${qs}`, {
          headers: this.authHeaders,
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                onLine(JSON.parse(line.slice(6)));
              } catch { /* skip malformed */ }
            }
          }
        }
      } catch { /* aborted or connection lost */ }
    })();

    return () => controller.abort();
  }

  // ── Cluster / HA Operations API ──

  // ── Service Management API ──

  async fetchServices(): Promise<import('@/types/api').ServiceDetail[]> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Services: HTTP ${res.status}`);
    return res.json();
  }

  async fetchService(id: string): Promise<import('@/types/api').ServiceDetail> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/${id}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Service: HTTP ${res.status}`);
    return res.json();
  }

  async createService(data: Record<string, unknown>): Promise<import('@/types/api').ServiceDetail> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`CreateService: HTTP ${res.status}`);
    return res.json();
  }

  async updateService(id: string, data: Record<string, unknown>): Promise<import('@/types/api').ServiceDetail> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`UpdateService: HTTP ${res.status}`);
    return res.json();
  }

  async deleteService(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/${id}`, { method: 'DELETE', headers: this.authHeaders });
    return res.ok;
  }

  async fetchServiceImpact(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/itsm/services/${id}/impact`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Impact: HTTP ${res.status}`);
    return res.json();
  }

  async generateServiceDocs(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/docs/generate`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify({ type: 'service_map', serviceId: id }) });
    if (!res.ok) throw new Error(`GenDocs: HTTP ${res.status}`);
    return res.json();
  }

  // ── SLA Management API ──

  async setSla(targetType: 'service' | 'asset', targetId: string, sla: import('@/types/api').SlaDefinition): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sla/set`, {
      method: 'POST',
      headers: this.jsonHeaders,
      body: JSON.stringify({ targetType, targetId, sla }),
    });
    if (!res.ok) throw new Error(`SetSLA: HTTP ${res.status}`);
    return res.json();
  }

  async getSlaReport(targetType: 'service' | 'asset', targetId: string, period?: string): Promise<any> {
    const params = period ? `?period=${period}` : '';
    const res = await fetch(`${this.baseUrl}/api/sla/report/${targetType}/${targetId}${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`SLAReport: HTTP ${res.status}`);
    return res.json();
  }

  async checkSlaCompliance(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sla/compliance`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`SLACompliance: HTTP ${res.status}`);
    return res.json();
  }

  async getSlaBreaches(period?: string): Promise<any[]> {
    const params = period ? `?period=${period}` : '';
    const res = await fetch(`${this.baseUrl}/api/sla/breaches${params}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`SLABreaches: HTTP ${res.status}`);
    return res.json();
  }

  async fetchClusterHealth(): Promise<import('@/types/api').ClusterHealthData> {
    const res = await fetch(`${this.baseUrl}/api/cluster/health`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Cluster: HTTP ${res.status}`);
    return res.json();
  }
}

export interface KGEntity {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  entityType: string;
  attributes: Record<string, unknown>;
  sources: string[];
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
  /** v921 — 'infra' = CMDB-synchronisierte IT-Infrastruktur, 'personal' = persönlicher Graph. */
  layer?: 'personal' | 'infra';
}

export interface KGRelation {
  id: string;
  userId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  strength: number;
  context: string | null;
  sourceSection: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

export interface MemoryEntry {
  id: string;
  userId: string;
  key: string;
  value: string;
  category: string;
  type: string;
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  relevantUntil?: string | null;
  sourceEventRefs?: string[] | null;
}

export interface Runbook {
  id: string;
  userId: string;
  title: string;
  symptom?: string;
  cause?: string;
  steps: string[];
  verification?: string;
  rollback?: string;
  sourceType?: 'itsm_incident' | 'project_agent' | 'chat_session' | 'manual';
  sourceId?: string;
  assetIds: string[];
  tags: string[];
  confidence: number;
  usageCount: number;
  lastUsedAt?: string;
  status: 'draft' | 'verified' | 'deprecated';
  createdAt: string;
  updatedAt: string;
}

// v638 — Insights
export interface InsightItem {
  id: string;
  userId: string;
  category: string;
  title: string;
  body: string;
  confidence: number;
  sourceData?: Record<string, unknown>;
  actionSkill?: string;
  actionParams?: Record<string, unknown>;
  status: 'pending' | 'acted' | 'dismissed' | 'snoozed' | 'expired';
  snoozedUntil?: string;
  dedupeKey?: string;
  createdAt: string;
  updatedAt: string;
}

// v930 — Interessen-Radar
export interface InterestSourceEntry {
  id: string;
  topicId: string;
  kind: 'rss' | 'web_search' | 'youtube';
  config: { url?: string; query?: string; channel?: string; channel_id_cached?: string };
  addedBy: 'auto' | 'manual';
  enabled: boolean;
  lastCheckedAt?: string;
  createdAt: string;
}

export interface InterestTopicItem {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  status: 'active' | 'paused' | 'archived';
  origin: 'auto' | 'manual';
  notifyThreshold: string;
  createdAt: string;
  lastActivityAt?: string;
  sources: InterestSourceEntry[];
  digest?: { topicId: string; summary: string; itemsSinceUpdate: number; updatedAt: string } | null;
  itemsLast7d: number;
}

export interface InterestItemEntry {
  id: string;
  topicId: string;
  title: string;
  url?: string;
  summary?: string;
  sourceKind: string;
  publishedAt?: string;
  importance?: number;
  createdAt: string;
}

export interface NotificationSettings {
  minUrgency: 'urgent' | 'high' | 'normal' | 'low';
  perSource: Record<string, 'urgent' | 'high' | 'normal' | 'low'>;
  devMode: boolean;
}

// v937 — Social
export interface SocialChannelItem {
  id: string;
  userId: string;
  projectId?: string;
  platform: string;
  name: string;
  handle?: string;
  mode: 'suggest' | 'approve' | 'autonomous';
  publishMode: 'api' | 'prepare';
  planningHorizonDays: number;
  postingSlots: string[];
  persona?: string;
  blacklist: string[];
  maxPostsPerDay: number;
  approvedStreak: number;
  status: 'active' | 'paused' | 'archived';
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // v965 — vom Server angereichert
  effectiveSlots?: { slots: string[]; source: 'user' | 'best-practice' };
  publishedToday?: number;
  imageBudget?: { used: number; total: number };
  topics?: Array<{ id: string; name: string }>;
}

export interface SocialContentItem {
  id: string;
  channelId: string;
  status: 'idea' | 'draft' | 'scheduled' | 'approved' | 'publishing' | 'published' | 'failed' | 'rejected';
  title?: string;
  body: string;
  media: Array<{ type: string; source: string; pathOrUrl: string }>;
  hashtags: string[];
  scheduledAt?: string;
  publishedAt?: string;
  externalUrl?: string;
  error?: string;
  performance?: Record<string, unknown>;
  source: string;
  createdAt: string;
  // v996 — Story-Zugehörigkeit (Familien-Kalender)
  storyId?: string;
  storyTitle?: string;
  storyKind?: string;
}

/** v1014 — Basis-Bild in der Bild-Bibliothek (Wiederverwendung). */
export interface SocialAssetItem {
  id: string;
  channelId?: string;
  channelName?: string;
  family?: string;
  path: string;
  basename: string;
  motif: string;
  style?: string;
  format?: string;
  lastUsedAt: string;
  useCount: number;
  blocked: boolean;
  /** v1072 — womit das Bild erzeugt wurde */
  model?: string;
  /** v1038 — Stamm-Bild: bevorzugter Wiederverwendungs-Pool */
  pinned?: boolean;
  createdAt: string;
}

// v639 — Goals
export interface GoalItem {
  id: string;
  userId: string;
  title: string;
  description?: string;
  category?: string;
  cadence?: string;
  targetMetric?: string;
  source: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  status: 'active' | 'paused' | 'achieved' | 'abandoned';
  checkFrequencyDays: number;
  lastCheckedAt?: string;
  lastStatus?: string;
  createdAt: string;
  updatedAt: string;
}
export interface GoalCheckpointItem {
  id: string;
  goalId: string;
  checkedAt: string;
  status?: string;
  notes?: string;
}

// v665b — Cluster-Shares + Move
export interface ClusterShareStatus {
  id: string;
  name?: string;
  mountPath: string;
  type: string;
  readOnly: boolean;
  available: boolean;
  writable: boolean;
  reason?: string;
}
export interface MovePreflightResult {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  sourceCwd?: string;
  targetCwd?: string;
}
export interface MoveResult {
  ok: boolean;
  sourceCwd?: string;
  targetCwd?: string;
  durationMs?: number;
  error?: string;
}

// v663b — Project Automations
export interface AutomationTemplate {
  kind: string;
  label: string;
  icon: string;
  defaultSchedule: string;
  description: string;
  defaultPrompt: string;
  collectors?: string[];
}
export interface ProjectAutomation {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  templateKind: string;
  schedule?: string;
  promptOverride?: string;
  outputDestination: 'telegram' | 'project_chat' | 'email' | 'web_notification';
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed' | 'skipped';
  lastRunOutput?: string;
  nextRunAt?: string;
  createdAt: string;
}

// v663a — Project Conventions Type
export interface ProjectConventions {
  readme?: { autoUpdate?: boolean; template?: 'default' | 'minimal' | 'custom' };
  changelog?: { autoUpdate?: boolean; format?: 'keepachangelog' | 'free' };
  commits?: { convention?: 'conventional' | 'free'; scopePolicy?: 'required' | 'optional' | 'forbidden' };
  branching?: { strategy?: 'main-only' | 'feature-branches' | 'gitflow'; prTarget?: string };
  versioning?: { scheme?: 'semver' | 'date' | 'custom'; autoTag?: boolean };
}

// v661 — Todos + Notes Types
export interface TodoItem {
  id: string;
  userId: string;
  list: string;
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  // v671 — Spiegel-Link zu Project-Open-Item
  linkedProjectId?: string;
  linkedOpenItemId?: string;
}

// v670 — Arbeits-/Fortschritts-Notiz an einem Todo
export interface TodoNote {
  id: string;
  todoId: string;
  userId: string;
  content: string;
  createdAt: string;
}

// v673 — Attachment an Todo oder Note (Document / FileStore-File / URL / Upload)
export interface AttachmentItem {
  id: string;
  userId: string;
  entityType: 'todo' | 'note';
  entityId: string;
  sourceKind: 'document' | 'file' | 'url' | 'upload';
  sourceRef: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export interface NoteItem {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// v659 — Letzte Deploys aus Memory
export interface ProjectLastDeploy {
  host: string;
  user: string;
  runtime?: string;
  processManager?: string;
  composeVariant?: string;
  port?: number;
  verified?: boolean;
  date?: string;
  // v677 — Failure-Status + Snippet
  failed?: boolean;
  error?: string;
  updatedAt?: string;
}

// v658 — Project Work-Stats + Chat-History
export interface ProjectWorkStats {
  // v668 — failedCount (cancelled/failed Sessions) separat ausgewiesen
  // v866 — tokensIn/Out + costUsd (CLI-eigene Subscriptions, Daten ab v866-Deploy)
  total: { count: number; totalSeconds: number; runningCount: number; failedCount?: number; tokensIn?: number; tokensOut?: number; cacheReadTokens?: number; costUsd?: number };
  byType: Array<{ sessionType: string; count: number; totalSeconds: number; completedCount: number; failedCount?: number; tokensIn?: number; tokensOut?: number; cacheReadTokens?: number; costUsd?: number }>;
  byAgent: Array<{ agent: string; count: number; totalSeconds: number }>;
  /** v866 — pro Agent/Version/Modell aus cli_agent_runs. */
  byAgentDetail?: Array<{ agent: string; detail: string; runs: number; durationS: number; tokensIn: number; tokensOut: number; cacheReadTokens?: number; costUsd: number }>;
}

/** v866 — Globale CLI-Agent-Usage-Übersicht (eigene Subscriptions/Keys). */
export interface CliUsageGroupRow {
  key: string;
  subKey?: string;
  runs: number;
  durationS: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number;
}
export interface CliUsageOverview {
  totals: { runs: number; durationS: number; tokensIn: number; tokensOut: number; cacheReadTokens: number; costUsd: number };
  byUser: CliUsageGroupRow[];
  byProject: CliUsageGroupRow[];
  byType: CliUsageGroupRow[];
  byAgent: CliUsageGroupRow[];
  byModel: CliUsageGroupRow[];
}

export interface ProjectChatHistory {
  conversationId: string;
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
}

// v847 — Project-Chat-Action-Tracking
export interface ChatActionSkillCallDto {
  skill: string;
  action?: string;
  durationMs: number;
  costUsd?: number;
  success: boolean;
  error?: string;
  startedAt: number;
}

// v851 — Project-Features Cross-Project Knowledge-Library
export interface ProjectFeatureDto {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string;
  techStack: string[];
  sourceFiles: string[];
  gitShaIntroduced: string | null;
  version: number;
  visibility: 'private' | 'role-shared' | 'global';
  confidence: number;
  source: 'auto' | 'manual' | 'imported';
  status: 'pending' | 'confirmed' | 'rejected';
  derivedFromFeatureId: string | null;
  /** v898 — Roadmap-Milestone, in den das Feature überführt wurde ("übernommen in"). */
  plannedMilestone?: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface ChatActionDto {
  id: string;
  projectId: string;
  conversationId: string | null;
  userId: string;
  requestText: string;
  responseText: string | null;
  skillsCalled: ChatActionSkillCallDto[];
  totalSkillCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  commitShas: string[];
  modifiedFiles: string[];
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  endedAt: string | null;
}

// v629 — Confirmations + Reminders Side-Panel
// v657 — extraActions für Multi-Action-Buttons
export interface ConfirmationExtraActionItem {
  key: string;
  label: string;
  kind: 'skill' | 'dismiss' | 'cancel-item' | 'defer';
  openItemId?: string;
  deferHours?: number;
}

export interface PendingConfirmationItem {
  id: string;
  chatId: string;
  platform: string;
  source: 'watch' | 'scheduled' | 'reasoning';
  sourceId: string;
  description: string;
  skillName: string;
  skillParams: Record<string, unknown>;
  extraActions?: ConfirmationExtraActionItem[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface ReminderListItem {
  id: string;
  message: string;
  triggerAt: string;
  platform: string;
  chatId?: string;
}

// v627 — Conversation History
export interface ConversationSummaryItem {
  id: string;
  platform: string;
  chatId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  // v644 — Lifecycle
  customLabel?: string;
  pinnedAt?: string;
  deletedAt?: string;
  branchedFromConversationId?: string;
}

export interface ConversationMessageItem {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: string;
  createdAt: string;
}

export interface ConversationSummary {
  conversationId: string;
  summary: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  updatedAt: string;
}

export interface ConversationSearchResult {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  score: number;
  platform: string;
  chatId: string;
}

// v623 — Background-Tasks (WebUI inspector)
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'checkpointed' | 'resuming';

export interface BackgroundTaskItem {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  description: string;
  skillName: string;
  skillInput: string;
  status: BackgroundTaskStatus;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  agentState?: string;
  checkpointAt?: string;
  resumeCount: number;
  maxDurationHours?: number;
}

// v609 — Project-Agent-Sessions (WebUI inspector)
export interface ProjectAgentSession {
  id: string;
  taskId: string;
  goal: string;
  cwd: string;
  agentName: string;
  currentPhase: string;
  currentIteration: number;
  totalFilesChanged: number;
  lastBuildPassed: boolean;
  lastCommitSha?: string;
  lastProgressAt?: string;
  milestones: string[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'maintenance' | 'archived';
export type ProjectHealthMode = 'full' | 'minimal' | 'off';
export type HealthProbe = 'git' | 'build' | 'deps' | 'http';
export type HealthStatus = 'ok' | 'warning' | 'error' | 'skipped';

export interface Project {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description?: string;
  cwd?: string;
  repoUrl?: string;
  /** v643 — Default-Branch (HEAD), auto-detected vom Project-Agent. */
  defaultBranch?: string;
  /** v726 — Default-ENV-Stage für Sandbox-Erstellung. */
  defaultEnvStage?: string;
  /** v732 — Default-DB-Seed für Sandbox-Erstellung. */
  defaultDbSeedId?: string;
  /** v755 — Per-Project-Quota für gleichzeitig aktive Sandboxes (NULL = User-Quota). */
  maxConcurrentSandboxes?: number;
  /** v875 — Soft-Budget für CLI-Agent-Kosten pro Woche (USD). NULL = kein Budget. */
  costBudgetWeeklyUsd?: number;
  /** v889 — CLI-Agent-Wahl-/Ausweich-Strategie pro Projekt. */
  agentStrategy?: { mode: 'auto' | 'manual'; preferred?: string; fallbackOrder?: string[] };
  status: ProjectStatus;
  healthMode: ProjectHealthMode;
  tags: string[];
  createdAt: string;
  lastActiveAt: string;
  nextCheckAt?: string;
  /** v663a — Optional pro-Projekt Conventions */
  conventions?: ProjectConventions;
  /** v665a — Storage-Typ 'local' (node-bound) oder 'shared' (auf Cluster-Share) */
  storageType?: 'local' | 'shared';
  /** v665a — bei shared: ID des Shares aus infra.shares */
  shareId?: string;
  /** v665a — bei local: hostende Cluster-Node */
  nodeId?: string;
  /** v665a — Active-Lock holder */
  lockedByNodeId?: string;
  /** v665a — Lock-TTL */
  lockedUntil?: string;
  /** v849 — Compose-Stack-Mode: 'single' (default) oder 'compose' (multi-service via docker-compose.yml) */
  sandboxMode?: 'single' | 'compose';
  /** v849 — Compose: Volumes überleben Sandbox-Discard (true) oder ephemer (false, default) */
  persistDbVolumes?: boolean;
  /** v849 — Wann project_db_seeds beim Sandbox-Start angewendet werden */
  dbSeedStrategy?: 'none' | 'first-start-only' | 'every-start';
}

// v643 — Per-Phase Commit eines Project-Agent-Laufs
export interface ProjectCommit {
  id: string;
  sessionId: string;
  projectId?: string;
  sha: string;
  message: string;
  phaseIdx?: number;
  phaseDescription?: string;
  filesChanged: number;
  branch?: string;
  committedAt: string;
  pushedAt?: string;
  pushUrl?: string;
}

export interface ProjectSession {
  id: string;
  projectId: string;
  sessionType: 'project_agent' | 'code_agent' | 'delegate' | 'chat';
  sourceId?: string;
  summary?: {
    whatWasDone?: string;
    keyDecisions?: Array<{ choice: string; rationale?: string }>;
    filesTouched?: string[];
    openItems?: Array<{ title: string; priority?: string; description?: string }>;
    status?: 'success' | 'failed' | 'partial';
    nextCheckInDays?: number;
  };
  startedAt: string;
  endedAt?: string;
  /** v812 — Sandbox-Lifecycle: 'applied' (klassisch) | 'pending' (ungemerged) | 'merged' | 'discarded' */
  mergeState?: 'applied' | 'pending' | 'merged' | 'discarded';
  sandboxId?: string;
}

export interface ProjectOpenItem {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  dueAt?: string;
  createdAt: string;
  resolvedAt?: string;
  /** ITSM-Incident-ID, falls dieses Open-Item ein bestehender Incident ist (Cross-Link). */
  linkedIncidentId?: string;
  /** ITSM-Change-ID, falls dieses Open-Item ein bestehender Change ist. */
  linkedChangeId?: string;
  /** v641 — wenn Alfred dieses Item nach einem Project-Agent-Run als möglicherweise erledigt erkannt hat. */
  autoResolvedBy?: string;
  /** v641 — Konfidenz (0..1) des Auto-Resolvers. */
  autoResolvedConfidence?: number;
  /** v875 — IDs anderer Open-Items, die VOR diesem erledigt sein müssen (⛓-Badge, Abarbeiten überspringt). */
  dependsOn?: string[];
  /** v663a — Roadmap-Milestone (frei: 'v2.0', 'Beta', 'Q3-2026') */
  roadmapMilestone?: string;
  /** v663a — Sortierung innerhalb des Milestones */
  roadmapOrder?: number;
  /** v663a — Geschätzte Aufwandsstunden */
  estimatedHours?: number;
  /** v671 — Spiegel-Link zu einem Todo */
  linkedTodoId?: string;
}

export interface ProjectDecision {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  choice: string;
  rationale?: string;
  alternativesConsidered?: string;
  createdAt: string;
}

export interface ProjectHealthEntry {
  id: string;
  projectId: string;
  probe: HealthProbe;
  status: HealthStatus;
  details?: string;
  durationMs: number;
  checkedAt: string;
}

export interface ProjectDetail {
  project: Project;
  sessions: ProjectSession[];
  openItems: ProjectOpenItem[];
  decisions: ProjectDecision[];
  health: Partial<Record<HealthProbe, ProjectHealthEntry>>;
}

/** v872 — frischer Git-Zustand für die Repo-Status-Karte. */
export interface ProjectRepoStatus {
  branch: string;
  sha: string;
  commitAgeDays: number;
  lastCommitAt: string;
  dirtyCount: number;
  dirtyFiles: string[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  defaultBranch?: string;
  onDefaultBranch?: boolean;
}

/** v872 — CI-Pipeline-Status (Forge-API) für das Badge in der Repo-Status-Karte. */
export interface ProjectPipelineInfo {
  provider: string;
  state: 'pending' | 'running' | 'success' | 'failure' | 'unknown';
  url?: string;
  ref: string;
}

/** v874 — offener MR/PR (vereinheitlicht GitLab/GitHub) für die Projekt-UI. */
export interface ProjectMergeRequest {
  provider: string;
  number: number;
  title: string;
  url: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
}

/** v873 — Markdown-Datei im Projekt-CWD (Docs-Tab). */
export interface ProjectDocFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** v879 — Befund eines Codebase-Reviews. */
export interface CodebaseReviewFinding {
  id: string;
  title: string;
  kind: 'security' | 'bug' | 'gap' | 'quality';
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  confidence: number;
  suggestedMilestone?: string;
  crossChecks?: Array<{ agent: string; verdict: 'confirmed' | 'refuted' | 'unclear'; note?: string }>;
}

/** v880 — Feature-Vorschlag aus der Discovery. */
export interface FeatureSuggestionItem {
  id: string;
  title: string;
  value: string;
  effort: 'S' | 'M' | 'L';
  rationale: string;
  proposedBy: string[];
}

/** v873 — veraltete direkte Dependency (Dependency-Panel). */
export interface ProjectOutdatedDep {
  name: string;
  current?: string;
  wanted?: string;
  latest?: string;
  type?: string;
}

// v699 — Sandbox-Types
export type SandboxStatus = 'creating' | 'running' | 'paused' | 'merging' | 'discarded' | 'failed' | 'cleaned';
export interface SandboxItem {
  id: string;
  projectId: string;
  sessionId: string | null;
  userId: string;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
  containerId: string | null;
  containerImage: string;
  hostPort: number | null;
  internalPort: number;
  projectType: string | null;
  status: SandboxStatus;
  statusReason: string | null;
  nodeId: string;
  ramPeakMb: number | null;
  diskUsedMb: number | null;
  createdAt: string;
  lastActiveAt: string;
  destroyedAt: string | null;
  result: string | null;
  resultPrUrl: string | null;
  /** v817 — kumulierte Sekunden aller bisherigen Running-Phasen. */
  totalRunSeconds?: number;
  /** v817 — Zeitstempel des letzten Übergangs nach 'running' (für Live-Counter). */
  lastResumedAt?: string | null;
  /** v817 — Zeitstempel des letzten Übergangs nach 'paused'. */
  lastPausedAt?: string | null;
  /** v723 — Default-Branch des Projects (dynamisch resolved für Merge-Dialog). */
  defaultBranch?: string;
}

export interface SandboxChatItem {
  id: string;
  sandboxId: string;
  userId: string;
  role: 'user' | 'agent';
  text: string;
  taskId: string | null;
  taskPhase: string | null;
  createdAt: string;
}

export interface SandboxStatusResponse {
  enabled: boolean;
  available: boolean;
  dockerAvailable?: boolean;
  worktreeBaseWritable?: boolean;
  healthCheckedAt?: string;
  defaultMode?: string;
  defaultMergeStrategy?: string;
  reason?: string;
  /** v739 — Limits für UI-Quota-Display */
  maxParallelPerUser?: number;
  diskQuotaPerUserMb?: number;
  idleTimeoutMin?: number;
}

// v824 — Agent-Conventions Frontend-Types (Phase 1)
export interface AgentConventionsStatus {
  projectId: string;
  packagePath: string;
  badge: 'present-fresh' | 'present-drift' | 'present-user-managed' | 'missing';
  filePath: string | null;
  filePresent: boolean;
  alfredManaged: boolean;
  lastAppliedAt: string | null;
  driftScore: number;
  contentHashCurrent: string | null;
  contentHashOnDisk: string | null;
}

export interface AgentConventionsGenerateData {
  draft: string;
  scanHash: string;
  contentHash: string;
  warnings: string[];
  costUsd: number;
  scanSnapshot: {
    framework?: string;
    packageManager?: string;
    testRunner?: string;
    workspaces?: string[];
    totalFiles: number;
    totalCodeFiles: number;
  };
}

export interface AgentConventionsApplyData {
  filesWritten: string[];
  commitSha?: string;
  historyId: string;
  backupCreated: boolean;
  /** v880.1 — beim Apply eines lesson-derived Drafts abgeräumte pending Lessons. */
  lessonsMarkedApplied?: number;
}

export interface AgentConventionsPackage {
  path: string;
  name: string;
  type: 'root' | 'pkg';
  filePath: string;
  hasConventionsRow: boolean;
  filePresent: boolean;
  driftScore: number;
  lastAppliedAt: string | null;
  pendingLessonsCount: number;
}

export interface AgentConventionsLesson {
  id: string;
  learnedAt: string;
  source: 'merge-gate-failure' | 'plan-fix-loop-resolved' | 'plan-awaiting-user' | 'user-chat-explicit' | 'drift-refresh-detected' | 'cross-project-pattern' | 'scan-update';
  text: string;
  sessionId?: string;
  confidence: number;
  appliedToMain: boolean;
  userApproved: boolean | null;
}

export interface AgentConventionsEffectivenessData {
  hasBaseline: boolean;
  reason?: string;
  appliedAt?: string;
  preApplyViolations?: number;
  postApplyViolations?: number;
  lessonsTotal?: number;
  lessonsApplied?: number;
  driftScore?: number;
  improvement?: number | null;
  confidence?: 'statistically-relevant' | 'too-few-samples';
}

export interface AgentConventionsPattern {
  id: string;
  masterUserId: string;
  patternText: string;
  patternSection: string;
  category: string;
  frameworkTags: string[];
  occurrenceCount: number;
  appliesToCount: number;
  confidence: number;
  firstObservedAt: string;
  lastObservedAt: string;
  retiredAt: string | null;
}

export interface AgentConventionsSectionHealth {
  section: string;
  violations: number;
  resolvedAnyway: number;
  manualOverrides: number;
  healthScore: number;
}

export interface AgentConventionsHistoryEntry {
  id: string;
  projectId: string;
  packagePath: string;
  appliedAt: string;
  appliedBy: string;
  prevContentHash: string | null;
  newContentHash: string;
  prevContentSnapshot: string | null;
  diffSummary: string | null;
  triggerSource: string;
  triggerSessionId: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
}
