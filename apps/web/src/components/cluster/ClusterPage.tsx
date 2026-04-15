'use client';

import { useState, useEffect, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { ClusterHealthData, ClusterNode, AdapterClaim, ReasoningSlotEntry } from '@/types/api';

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

export function ClusterPage() {
  const { client } = useConfig();
  const [data, setData] = useState<ClusterHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await client.fetchClusterHealth();
      setData(d);
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

      {/* Nodes */}
      <section>
        <h2 className="text-sm font-medium text-gray-400 mb-3">Nodes</h2>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
          {data.nodes.map(node => (
            <NodeCard key={node.nodeId} node={node} isThis={node.nodeId === data.thisNodeId} />
          ))}
        </div>
      </section>

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

function NodeCard({ node, isThis }: { node: ClusterNode; isThis: boolean }) {
  return (
    <div className={clsx(
      'bg-[#111111] border rounded-xl p-4',
      isThis ? 'border-blue-500/30' : 'border-[#1f1f1f]',
    )}>
      <div className="flex items-center gap-2 mb-2">
        <span className={clsx('w-2.5 h-2.5 rounded-full', node.alive ? 'bg-green-500' : 'bg-red-500')} />
        <span className="text-sm font-medium text-gray-200">{node.nodeId}</span>
        {isThis && <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">this</span>}
        {node.version && <span className="text-[10px] text-gray-500 ml-auto font-mono">{node.version}</span>}
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
            {formatAgo(node.lastSeenAt)}
          </span>
        </div>
        {node.adapters.length > 0 && (
          <div className="flex justify-between">
            <span>Adapters</span>
            <span className="text-gray-300">{node.adapters.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
