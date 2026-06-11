'use client';

import { useState, useEffect, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { ClusterHealthData, ClusterNode, AdapterClaim, ReasoningSlotEntry, NodeDiskMetric } from '@/types/api';
import type { SandboxItem } from '@/lib/alfred-client';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3600_000)}h ago`;
}

function formatSlotTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** v865 — "11.06. 08:26" für Offline-seit-Anzeige. */
function formatDateTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** v865 — Farbe für Auslastungs-Balken: grün < 80%, gelb < 90%, rot ≥ 90%. */
function usageColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500/80';
  if (pct >= 80) return 'bg-amber-500/80';
  return 'bg-emerald-500/70';
}

/** v865 — Schmaler Auslastungs-Balken mit Label. */
function UsageBar({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  return (
    <div>
      <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
        <span>{label}</span>
        <span className={clsx(pct >= 90 ? 'text-red-400' : pct >= 80 ? 'text-amber-400' : 'text-gray-400')}>
          {detail}
        </span>
      </div>
      <div className="h-1.5 bg-[#1f1f1f] rounded overflow-hidden">
        <div className={clsx('h-full rounded', usageColor(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

interface NodeSandboxStats {
  total: number;
  running: number;
  paused: number;
  failed: number;
  ramMb: number;
  oldestRunningSince?: string;
}

function aggregateSandboxesByNode(sandboxes: SandboxItem[]): Record<string, NodeSandboxStats> {
  const acc: Record<string, NodeSandboxStats> = {};
  for (const s of sandboxes) {
    if (s.status === 'cleaned' || s.status === 'discarded' || s.status === 'merging') continue;
    const node = s.nodeId || 'unknown';
    if (!acc[node]) acc[node] = { total: 0, running: 0, paused: 0, failed: 0, ramMb: 0 };
    acc[node].total++;
    if (s.status === 'running') {
      acc[node].running++;
      if (typeof s.ramPeakMb === 'number') acc[node].ramMb += s.ramPeakMb;
      if (!acc[node].oldestRunningSince || s.createdAt < acc[node].oldestRunningSince) {
        acc[node].oldestRunningSince = s.createdAt;
      }
    } else if (s.status === 'paused') {
      acc[node].paused++;
    } else if (s.status === 'failed') {
      acc[node].failed++;
    }
  }
  return acc;
}

export function ClusterPage() {
  const { client } = useConfig();
  const [data, setData] = useState<ClusterHealthData | null>(null);
  const [sandboxStats, setSandboxStats] = useState<Record<string, NodeSandboxStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, sandboxes] = await Promise.all([
        client.fetchClusterHealth(),
        client.listAllSandboxes().catch(() => [] as SandboxItem[]),
      ]);
      setData(d);
      setSandboxStats(aggregateSandboxesByNode(sandboxes));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (loading) return <div className="p-8 text-gray-400">Laden...</div>;
  if (error) return <div className="p-8 text-red-400">Fehler: {error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-200">Cluster & Operations</h1>
          <span className={clsx(
            'px-2 py-0.5 text-[10px] rounded-full font-medium',
            data.clusterEnabled ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400',
          )}>
            {data.clusterEnabled ? 'HA Cluster' : 'Single Node'}
          </span>
        </div>
        <button onClick={refresh} className="text-sm text-blue-400 hover:text-blue-300">Aktualisieren</button>
      </div>

      {/* v865 — Versions-Drift-Warnung: laufende Nodes mit unterschiedlichen Versionen */}
      {(() => {
        const liveVersions = [...new Set(data.nodes.filter(n => n.alive && n.version).map(n => n.version))];
        if (liveVersions.length <= 1) return null;
        return (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-sm text-amber-300">
            ⚠ Versions-Drift: aktive Nodes laufen auf unterschiedlichen Versionen ({liveVersions.join(' vs. ')}).
          </div>
        );
      })()}

      {/* Nodes */}
      <section>
        <h2 className="text-sm font-medium text-gray-400 mb-3">Nodes</h2>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
          {data.nodes.map(node => (
            <NodeCard key={node.nodeId} node={node} isThis={node.nodeId === data.thisNodeId} sandboxStats={sandboxStats[node.nodeId]} />
          ))}
        </div>
      </section>

      {/* v865 — Infrastruktur: DB / Redis / FileStore */}
      {data.infra && (data.infra.database || data.infra.redis || data.infra.fileStore) && (
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Infrastruktur</h2>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
            {data.infra.database && (
              <InfraCard
                name={data.infra.database.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
                ok={data.infra.database.ok}
                detail={data.infra.database.sizeMb !== undefined ? `DB-Größe: ${data.infra.database.sizeMb >= 1024 ? `${(data.infra.database.sizeMb / 1024).toFixed(1)} GB` : `${data.infra.database.sizeMb} MB`}` : undefined}
                error={data.infra.database.error}
              />
            )}
            {data.infra.redis && (
              <InfraCard name="Redis" ok={data.infra.redis.ok} detail="Cluster Pub/Sub + Locks" />
            )}
            {data.infra.fileStore && (
              <InfraCard
                name={data.infra.fileStore.backend === 's3' ? 'MinIO / S3' : `FileStore (${data.infra.fileStore.backend})`}
                ok={data.infra.fileStore.ok}
                detail="Datei-Uploads"
                error={data.infra.fileStore.error}
              />
            )}
          </div>
        </section>
      )}

      {/* Adapter Claims */}
      {data.claims.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Adapter Claims</h2>
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-[#1f1f1f]">
                  <th className="px-4 py-2">Platform</th>
                  <th className="px-4 py-2">Node</th>
                  <th className="px-4 py-2">Claimed</th>
                  <th className="px-4 py-2">Expires</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.claims.map((claim: AdapterClaim) => (
                  <tr key={claim.platform} className="border-b border-[#141414]">
                    <td className="px-4 py-2 text-gray-200 capitalize">{claim.platform}</td>
                    <td className="px-4 py-2 text-gray-300 font-mono text-xs">{claim.nodeId}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{formatAgo(claim.claimedAt)}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{formatAgo(claim.expiresAt)}</td>
                    <td className="px-4 py-2">
                      <span className={clsx(
                        'inline-flex items-center gap-1 text-xs',
                        claim.active ? 'text-green-400' : 'text-red-400',
                      )}>
                        <span className={clsx('w-1.5 h-1.5 rounded-full', claim.active ? 'bg-green-500' : 'bg-red-500')} />
                        {claim.active ? 'active' : 'expired'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Reasoning Slots */}
      {data.recentReasoningSlots.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">
            Reasoning Passes (letzte 20)
          </h2>
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-[#1f1f1f]">
                  <th className="px-4 py-2">Slot</th>
                  <th className="px-4 py-2">Node</th>
                  <th className="px-4 py-2">Claimed At</th>
                </tr>
              </thead>
              <tbody>
                {data.recentReasoningSlots.map((slot: ReasoningSlotEntry, i: number) => (
                  <tr key={i} className="border-b border-[#141414]">
                    <td className="px-4 py-2 text-gray-300 font-mono text-xs">{slot.slotKey}</td>
                    <td className="px-4 py-2 text-gray-300 font-mono text-xs">{slot.nodeId}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{formatSlotTime(slot.claimedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Operations Status */}
      <section>
        <h2 className="text-sm font-medium text-gray-400 mb-3">Operations</h2>
        <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Reasoning Schedule</span>
            <span className="text-xs text-gray-400 font-mono">{data.operations.reasoning?.schedule ?? 'disabled'}</span>
          </div>
          {data.operations.backup && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-300">Backup Schedule</span>
              <span className="text-xs text-gray-400 font-mono">{data.operations.backup.schedule}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function NodeCard({ node, isThis, sandboxStats }: { node: ClusterNode; isThis: boolean; sandboxStats?: NodeSandboxStats }) {
  return (
    <div className={clsx(
      'bg-[#111111] border rounded-xl p-4',
      isThis ? 'border-blue-500/30' : 'border-[#1f1f1f]',
    )}>
      <div className="flex items-center gap-2 mb-2">
        <span className={clsx('w-2.5 h-2.5 rounded-full', node.alive ? 'bg-green-500' : 'bg-red-500')} />
        <span className="text-sm font-medium text-gray-200">{node.nodeId}</span>
        {isThis && <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">this</span>}
        {/* v865 — Version prominent als Badge statt grauem Kleintext */}
        {node.version && (
          <span className="text-[10px] px-1.5 py-0.5 bg-violet-500/15 text-violet-300 rounded ml-auto font-mono">
            v{node.version.replace(/^v/, '')}
          </span>
        )}
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        <div className="flex justify-between">
          <span>Host</span>
          <span className="text-gray-300">{node.host || '-'}</span>
        </div>
        <div className="flex justify-between">
          <span>Uptime</span>
          <span className="text-gray-300">{formatUptime(node.uptimeS)}</span>
        </div>
        <div className="flex justify-between">
          <span>Last Seen</span>
          <span className={clsx(node.alive ? 'text-green-400' : 'text-red-400')}>
            {/* v865 — offline-Nodes zeigen Datum statt "500h ago" */}
            {node.alive ? formatAgo(node.lastSeenAt) : `offline seit ${formatDateTime(node.lastSeenAt)}`}
          </span>
        </div>
        {node.adapters.length > 0 && (
          <div className="flex justify-between">
            <span>Adapters</span>
            <span className="text-gray-300">{node.adapters.join(', ')}</span>
          </div>
        )}
        {/* v865 — System-Details aus dem Heartbeat (fehlt bei alten Alfred-Versionen) */}
        {node.metrics?.platform && (
          <div className="flex justify-between">
            <span>System</span>
            <span className="text-gray-300">
              {node.metrics.platform}{node.metrics.osRelease ? ` ${node.metrics.osRelease}` : ''}
              {node.metrics.nodeJs ? ` · Node ${node.metrics.nodeJs.replace(/^v/, '')}` : ''}
            </span>
          </div>
        )}
        {node.metrics?.cpuCores !== undefined && (
          <div className="flex justify-between">
            <span>CPU-Load (1m)</span>
            <span className={clsx(
              (node.metrics.cpuLoad1m ?? 0) >= node.metrics.cpuCores ? 'text-red-400'
                : (node.metrics.cpuLoad1m ?? 0) >= node.metrics.cpuCores * 0.7 ? 'text-amber-400'
                : 'text-gray-300',
            )}>
              {node.metrics.cpuLoad1m ?? 0} / {node.metrics.cpuCores} Cores
            </span>
          </div>
        )}
      </div>
      {/* v865 — RAM + Disk-Auslastung (nur bei alive-Nodes sinnvoll, Daten sind sonst veraltet) */}
      {node.alive && node.metrics?.memTotalMb !== undefined && node.metrics.memTotalMb > 0 && (
        <div className="mt-3 pt-3 border-t border-[#1f1f1f] space-y-2">
          <UsageBar
            label={`RAM${node.metrics.rssMb ? ` (Alfred: ${node.metrics.rssMb} MB)` : ''}`}
            pct={Math.round((1 - (node.metrics.memFreeMb ?? 0) / node.metrics.memTotalMb) * 100)}
            detail={`${(((node.metrics.memTotalMb - (node.metrics.memFreeMb ?? 0)) / 1024)).toFixed(1)} / ${(node.metrics.memTotalMb / 1024).toFixed(1)} GB`}
          />
          {(node.metrics.disks ?? []).map((disk: NodeDiskMetric) => (
            <UsageBar
              key={disk.path}
              label={`Disk ${disk.path}`}
              pct={disk.usedPct}
              detail={`${disk.usedPct}% · ${disk.freeGb} GB frei von ${disk.totalGb} GB`}
            />
          ))}
        </div>
      )}
      {/* v754 — Sandbox-Verteilung pro Node */}
      <div className="mt-3 pt-3 border-t border-[#1f1f1f]">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-gray-400">Sandboxes</span>
          <span className="text-gray-300 font-mono">{sandboxStats?.total ?? 0}</span>
        </div>
        {sandboxStats && sandboxStats.total > 0 ? (
          <>
            <div className="flex gap-1 mb-2">
              {sandboxStats.running > 0 && (
                <div
                  className="h-2 bg-emerald-500/70 rounded-l"
                  style={{ flex: sandboxStats.running }}
                  title={`${sandboxStats.running} running`}
                />
              )}
              {sandboxStats.paused > 0 && (
                <div
                  className="h-2 bg-blue-500/70"
                  style={{ flex: sandboxStats.paused }}
                  title={`${sandboxStats.paused} paused`}
                />
              )}
              {sandboxStats.failed > 0 && (
                <div
                  className="h-2 bg-red-500/70 rounded-r"
                  style={{ flex: sandboxStats.failed }}
                  title={`${sandboxStats.failed} failed`}
                />
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-400">
              {sandboxStats.running > 0 && (
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{sandboxStats.running} running</span>
              )}
              {sandboxStats.paused > 0 && (
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />{sandboxStats.paused} paused</span>
              )}
              {sandboxStats.failed > 0 && (
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />{sandboxStats.failed} failed</span>
              )}
            </div>
            {sandboxStats.ramMb > 0 && (
              <div className="mt-1.5 flex justify-between text-[10px] text-gray-500">
                <span>RAM-Peak Sum</span>
                <span className="text-gray-400">{sandboxStats.ramMb} MB</span>
              </div>
            )}
            {sandboxStats.oldestRunningSince && (
              <div className="flex justify-between text-[10px] text-gray-500">
                <span>Älteste running</span>
                <span className="text-gray-400">{formatAgo(sandboxStats.oldestRunningSince)}</span>
              </div>
            )}
          </>
        ) : (
          <span className="text-[10px] text-gray-600 italic">— keine —</span>
        )}
      </div>
    </div>
  );
}

/** v865 — Status-Karte für PG/Redis/MinIO in der Infrastruktur-Sektion. */
function InfraCard({ name, ok, detail, error }: { name: string; ok: boolean; detail?: string; error?: string }) {
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
      <div className="flex items-center gap-2">
        <span className={clsx('w-2.5 h-2.5 rounded-full', ok ? 'bg-green-500' : 'bg-red-500')} />
        <span className="text-sm font-medium text-gray-200">{name}</span>
        <span className={clsx('ml-auto text-xs', ok ? 'text-green-400' : 'text-red-400')}>
          {ok ? 'erreichbar' : 'down'}
        </span>
      </div>
      {detail && <div className="mt-2 text-xs text-gray-400">{detail}</div>}
      {!ok && error && <div className="mt-1 text-[10px] text-red-400/80 font-mono break-all">{error}</div>}
    </div>
  );
}
