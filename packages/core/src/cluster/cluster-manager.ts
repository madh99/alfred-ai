/**
 * Cluster Manager — coordinates multiple Alfred nodes.
 * Uses Redis for:
 * - Heartbeat/health monitoring
 * - Distributed locks (watch dedup, scheduler dedup)
 * - Cross-node message routing
 * - Config sync events
 *
 * SQLite remains the primary database on each node.
 * For shared state, nodes sync via Redis pub/sub.
 */
import type { Logger } from 'pino';

export interface ClusterConfig {
  enabled: boolean;
  nodeId: string;
  role: 'primary' | 'secondary';
  redisUrl: string;
  nodes?: Array<{ id: string; host: string; port: number; priority: number }>;
  heartbeatIntervalMs?: number;
  failoverAfterMs?: number;
}

export interface ClusterNode {
  id: string;
  host: string;
  port: number;
  role: 'primary' | 'secondary';
  adapters: string[];
  lastHeartbeat: string;
  healthy: boolean;
}

export class ClusterManager {
  private redis: any;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly heartbeatMs: number;
  private readonly failoverMs: number;

  constructor(
    private readonly config: ClusterConfig,
    private readonly logger: Logger,
  ) {
    this.heartbeatMs = config.heartbeatIntervalMs ?? 10_000;
    this.failoverMs = config.failoverAfterMs ?? 30_000;
  }

  async connect(): Promise<void> {
    try {
      const Redis = (await (Function('return import("ioredis")')() as Promise<{ default: any }>)).default;
      this.redis = new Redis(this.config.redisUrl);
      this.logger.info({ nodeId: this.config.nodeId, role: this.config.role }, 'Cluster manager connected to Redis');
    } catch (err) {
      this.logger.error({ err }, 'Failed to connect to Redis — cluster features disabled');
      return;
    }

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
    await this.sendHeartbeat();
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.redis?.quit();
  }

  // ── Heartbeat ──────────────────────────────────────────────

  private async sendHeartbeat(): Promise<void> {
    try {
      const data = JSON.stringify({
        id: this.config.nodeId,
        role: this.config.role,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
      });
      await this.redis.set(`alfred:cluster:heartbeat:${this.config.nodeId}`, data, 'EX', Math.ceil(this.failoverMs / 1000));
    } catch (err) {
      this.logger.warn({ err }, 'Heartbeat send failed');
    }
  }

  async getNodes(): Promise<ClusterNode[]> {
    if (!this.redis) return [];
    try {
      const keys = await this.redis.keys('alfred:cluster:heartbeat:*');
      const nodes: ClusterNode[] = [];
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (raw) {
          try {
            const data = JSON.parse(raw);
            nodes.push({ ...data, healthy: true });
          } catch { /* skip corrupt */ }
        }
      }
      return nodes;
    } catch {
      return [];
    }
  }

  // ── Distributed Locks ──────────────────────────────────────

  /**
   * Try to acquire a distributed lock. Returns true if acquired.
   * Lock auto-expires after ttlMs.
   */
  async acquireLock(key: string, ttlMs = 300_000): Promise<boolean> {
    if (!this.redis) return true; // No Redis = single node, always acquire
    try {
      const result = await this.redis.set(
        `alfred:lock:${key}`,
        this.config.nodeId,
        'NX',
        'PX',
        ttlMs,
      );
      return result === 'OK';
    } catch {
      return true; // On error, allow execution (fail-open)
    }
  }

  async releaseLock(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      const owner = await this.redis.get(`alfred:lock:${key}`);
      if (owner === this.config.nodeId) {
        await this.redis.del(`alfred:lock:${key}`);
      }
    } catch { /* ignore */ }
  }

  // ── Pub/Sub ────────────────────────────────────────────────

  /**
   * Publish an event to all nodes.
   */
  async publish(channel: string, data: Record<string, unknown>): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(`alfred:${channel}`, JSON.stringify({ ...data, nodeId: this.config.nodeId }));
    } catch (err) {
      this.logger.warn({ err, channel }, 'Cluster publish failed');
    }
  }

  /**
   * Subscribe to events from other nodes.
   */
  async subscribe(channel: string, handler: (data: Record<string, unknown>) => void): Promise<void> {
    if (!this.redis) return;
    try {
      const sub = this.redis.duplicate();
      await sub.subscribe(`alfred:${channel}`);
      sub.on('message', (_ch: string, msg: string) => {
        try {
          const data = JSON.parse(msg);
          if (data.nodeId !== this.config.nodeId) { // Ignore own messages
            handler(data);
          }
        } catch { /* ignore corrupt */ }
      });
    } catch (err) {
      this.logger.warn({ err, channel }, 'Cluster subscribe failed');
    }
  }

  // ── Cross-Node Message Routing ─────────────────────────────

  /**
   * Route a message to another node's adapter.
   */
  async routeMessage(targetPlatform: string, chatId: string, text: string): Promise<void> {
    await this.publish('messages', { type: 'send_message', targetPlatform, chatId, text });
  }

  // ── Failover Detection ──────────────────────────────────────

  private failoverCheckTimer?: ReturnType<typeof setInterval>;
  private onFailoverCallback?: (deadNodeId: string) => void;

  /**
   * Start monitoring other nodes. Calls onFailover when a node goes down.
   * Only secondary nodes should call this (to detect primary failure).
   */
  startFailoverMonitoring(onFailover: (deadNodeId: string) => void): void {
    if (this.config.role !== 'secondary') return;
    this.onFailoverCallback = onFailover;

    this.failoverCheckTimer = setInterval(async () => {
      try {
        const liveNodes = await this.getNodes();
        const liveIds = new Set(liveNodes.map(n => n.id));

        // Check if any configured node with role 'primary' is missing
        for (const node of (this.config.nodes ?? [])) {
          if (node.id === this.config.nodeId) continue; // skip self
          if (!liveIds.has(node.id)) {
            this.logger.warn({ deadNodeId: node.id }, 'Node heartbeat missing — failover triggered');
            this.onFailoverCallback?.(node.id);
          }
        }
      } catch (err) {
        this.logger.debug({ err }, 'Failover check error');
      }
    }, this.failoverMs);
  }

  stopFailoverMonitoring(): void {
    if (this.failoverCheckTimer) clearInterval(this.failoverCheckTimer);
  }

  /**
   * Announce that this node is taking over adapters from a dead node.
   */
  async announceTakeover(deadNodeId: string, adapters: string[]): Promise<void> {
    await this.publish('events', { type: 'failover', deadNodeId, takenOverBy: this.config.nodeId, adapters });
    this.logger.info({ deadNodeId, adapters }, 'Failover: adapters taken over');
  }

  // ── Config Sync ────────────────────────────────────────────

  /**
   * Broadcast a config change to all nodes.
   */
  async syncConfig(changeType: string, details: Record<string, unknown>): Promise<void> {
    await this.publish('config-sync', { type: changeType, ...details });
  }

  /**
   * Listen for config changes from other nodes.
   */
  async onConfigSync(handler: (changeType: string, details: Record<string, unknown>) => void): Promise<void> {
    await this.subscribe('config-sync', (data) => {
      const { type, ...details } = data;
      handler(type as string, details);
    });
  }

  // ── Status ─────────────────────────────────────────────────

  get nodeId(): string { return this.config.nodeId; }
  get role(): string { return this.config.role; }
  get isConnected(): boolean { return !!this.redis; }
}
