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
}
