import { readSseStream } from './sse-reader';
import type { DashboardData, HealthData, Attachment } from '@/types/api';

export interface StreamCallbacks {
  onStatus: (text: string) => void;
  onResponse: (text: string) => void;
  onAttachment: (a: Attachment) => void;
  onDone: () => void;
  onError: (err: string) => void;
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
  ): () => void {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({ text, chatId, userId }),
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

  async fetchDashboard(range?: 'today' | 'week' | 'month' | 'year' | 'all'): Promise<DashboardData> {
    const qs = range ? `?range=${range}` : '';
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
  openProjectAgentOutputStream(taskId: string, onLine: (line: { ts: number; source: string; text: string }) => void, onHistory?: (lines: Array<{ ts: number; source: string; text: string }>) => void): EventSource {
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
  async actOnInsight(id: string): Promise<{ ok: boolean; result?: any; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/insights/${id}/act`, { method: 'POST', headers: this.authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.reason ?? `http-${res.status}` };
    return data;
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

  async decideConfirmation(id: string, decision: 'approve' | 'reject'): Promise<{ ok: boolean; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/confirmations/${id}/${decision}`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error ?? `http-${res.status}` };
    return { ok: true };
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

  // v641 — Bulk-Work + Audit für Open-Items
  async projectWorkOnOpenItems(projectId: string, itemIds: string[], maxItems = 10): Promise<{ ok: boolean; taskId?: string; reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/work-on-items`, {
      method: 'POST', headers: this.jsonHeaders,
      body: JSON.stringify({ item_ids: itemIds, max_items: maxItems }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error ?? `http-${res.status}` };
    return { ok: true, taskId: data.taskId };
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

  async fetchLogs(options?: { lines?: number; level?: string; filter?: string; fileIndex?: number }): Promise<import('@/types/api').LogResponse> {
    const params = new URLSearchParams();
    if (options?.lines) params.set('lines', String(options.lines));
    if (options?.level) params.set('level', options.level);
    if (options?.filter) params.set('filter', options.filter);
    if (options?.fileIndex !== undefined) params.set('file', String(options.fileIndex));
    const qs = params.toString() ? `?${params}` : '';
    const res = await fetch(`${this.baseUrl}/api/logs/app${qs}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Logs: HTTP ${res.status}`);
    return res.json();
  }

  async fetchAuditLogs(lines?: number, fileIndex?: number): Promise<import('@/types/api').LogResponse> {
    const params = new URLSearchParams();
    if (lines) params.set('lines', String(lines));
    if (fileIndex !== undefined) params.set('file', String(fileIndex));
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

// v629 — Confirmations + Reminders Side-Panel
export interface PendingConfirmationItem {
  id: string;
  chatId: string;
  platform: string;
  source: 'watch' | 'scheduled' | 'reasoning';
  sourceId: string;
  description: string;
  skillName: string;
  skillParams: Record<string, unknown>;
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
  status: ProjectStatus;
  healthMode: ProjectHealthMode;
  tags: string[];
  createdAt: string;
  lastActiveAt: string;
  nextCheckAt?: string;
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
  /** v641 — wenn Alfred dieses Item nach einem Project-Agent-Run als möglicherweise erledigt erkannt hat. */
  autoResolvedBy?: string;
  /** v641 — Konfidenz (0..1) des Auto-Resolvers. */
  autoResolvedConfidence?: number;
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
