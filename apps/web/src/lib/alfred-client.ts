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

  async fetchDashboard(): Promise<DashboardData> {
    const res = await fetch(`${this.baseUrl}/api/dashboard`, {
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
