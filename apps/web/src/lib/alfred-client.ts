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
