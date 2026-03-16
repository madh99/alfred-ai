/**
 * Node Auto-Discovery via UDP Broadcast.
 * Primary broadcasts its presence, secondaries listen.
 */
import dgram from 'node:dgram';
import type { Logger } from 'pino';

const DISCOVERY_PORT = 3421;
const DISCOVERY_MAGIC = 'ALFRED_CLUSTER_V1';

export interface DiscoveredNode {
  nodeId: string;
  host: string;
  port: number;
  role: string;
  redisUrl: string;
}

export class ClusterDiscovery {
  private socket: dgram.Socket | null = null;
  private broadcastTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly logger: Logger) {}

  /**
   * Start broadcasting this node's presence (primary only).
   */
  startBroadcasting(nodeInfo: { nodeId: string; host: string; port: number; role: string; redisUrl: string }): void {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.bind(() => {
      this.socket!.setBroadcast(true);

      const message = Buffer.from(JSON.stringify({
        magic: DISCOVERY_MAGIC,
        ...nodeInfo,
        timestamp: Date.now(),
      }));

      this.broadcastTimer = setInterval(() => {
        try {
          this.socket!.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255');
        } catch (err) {
          this.logger.debug({ err }, 'Discovery broadcast failed');
        }
      }, 5_000);

      this.logger.info({ port: DISCOVERY_PORT }, 'Cluster discovery broadcasting started');
    });
  }

  /**
   * Listen for primary node broadcasts (secondary/joining node).
   * Returns a promise that resolves with the first discovered node.
   */
  async discoverPrimary(timeoutMs = 15_000): Promise<DiscoveredNode | null> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let found = false;

      const timer = setTimeout(() => {
        if (!found) {
          socket.close();
          resolve(null);
        }
      }, timeoutMs);

      socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.magic === DISCOVERY_MAGIC && data.role === 'primary') {
            found = true;
            clearTimeout(timer);
            socket.close();
            this.logger.info({ nodeId: data.nodeId, host: rinfo.address, port: data.port }, 'Discovered primary node');
            resolve({
              nodeId: data.nodeId,
              host: rinfo.address,
              port: data.port,
              role: data.role,
              redisUrl: data.redisUrl,
            });
          }
        } catch { /* ignore non-Alfred packets */ }
      });

      socket.bind(DISCOVERY_PORT, () => {
        this.logger.info({ port: DISCOVERY_PORT }, 'Listening for cluster discovery broadcasts...');
      });

      socket.on('error', (err) => {
        this.logger.warn({ err }, 'Discovery listen error');
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  stop(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.socket?.close();
    this.socket = null;
  }
}
