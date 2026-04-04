'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useConfig } from '@/context/ConfigContext';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const TYPE_COLORS: Record<string, string> = {
  server: '#f87171',
  vm: '#60a5fa',
  lxc: '#60a5fa',
  container: '#34d399',
  dns: '#facc15',
  proxy: '#fb923c',
  firewall: '#a78bfa',
  network: '#22d3ee',
  service: '#f472b6',
  storage: '#9ca3af',
};

const STATUS_COLORS: Record<string, string> = {
  active: '#34d399',
  inactive: '#9ca3af',
  maintenance: '#facc15',
  decommissioned: '#f87171',
  unknown: '#6b7280',
};

interface CmdbAsset {
  id: string;
  assetType: string;
  name: string;
  ipAddress: string | null;
  hostname: string | null;
  fqdn: string | null;
  status: string;
  environment: string | null;
  sourceSkill: string | null;
  sourceId: string | null;
  owner: string | null;
  purpose: string | null;
  tags: string[];
  notes: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

interface CmdbRelation {
  id: string;
  sourceAssetId: string;
  targetAssetId: string;
  relationType: string;
  autoDiscovered: boolean;
}

interface CmdbChange {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  changedBy: string | null;
}

interface CmdbStats {
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  total: number;
}

interface GraphNode {
  id: string;
  name: string;
  assetType: string;
  color: string;
  status: string;
  ipAddress: string | null;
  val: number;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  source: string;
  target: string;
  relationType: string;
}

type ViewMode = 'table' | 'topology';

export function CmdbPage() {
  const { client } = useConfig();
  const [assets, setAssets] = useState<CmdbAsset[]>([]);
  const [relations, setRelations] = useState<CmdbRelation[]>([]);
  const [stats, setStats] = useState<CmdbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');

  // Filters
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterEnv, setFilterEnv] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Selection & detail
  const [selectedAsset, setSelectedAsset] = useState<CmdbAsset | null>(null);
  const [assetRelations, setAssetRelations] = useState<CmdbRelation[]>([]);
  const [assetChanges, setAssetChanges] = useState<CmdbChange[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit mode
  const [editMode, setEditMode] = useState(false);
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  // Discovery
  const [discovering, setDiscovering] = useState(false);

  // Graph
  const graphRef = useRef<any>(null);
  const nodePositions = useRef<Map<string, { fx: number; fy: number }>>(new Map());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [assetList, relationList, statsData] = await Promise.all([
        client.cmdbListAssets(),
        client.cmdbListRelations(),
        client.cmdbGetStats(),
      ]);
      setAssets(assetList);
      setRelations(relationList);
      setStats(statsData);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const selectAsset = useCallback(async (asset: CmdbAsset) => {
    setSelectedAsset(asset);
    setEditMode(false);
    setDetailLoading(true);
    try {
      const detail = await client.cmdbGetAsset(asset.id);
      setAssetRelations(detail.relations ?? []);
      setAssetChanges(detail.changes ?? []);
    } catch {
      setAssetRelations([]);
      setAssetChanges([]);
    } finally {
      setDetailLoading(false);
    }
  }, [client]);

  const filteredAssets = useMemo(() => {
    let result = assets;
    if (filterType !== 'all') result = result.filter(a => a.assetType === filterType);
    if (filterStatus !== 'all') result = result.filter(a => a.status === filterStatus);
    if (filterEnv !== 'all') result = result.filter(a => a.environment === filterEnv);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.ipAddress ?? '').includes(q) ||
        (a.hostname ?? '').toLowerCase().includes(q) ||
        (a.fqdn ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [assets, filterType, filterStatus, filterEnv, searchQuery]);

  // Unique values for filter dropdowns
  const uniqueTypes = useMemo(() => [...new Set(assets.map(a => a.assetType))].sort(), [assets]);
  const uniqueStatuses = useMemo(() => [...new Set(assets.map(a => a.status))].sort(), [assets]);
  const uniqueEnvs = useMemo(() => [...new Set(assets.map(a => a.environment).filter(Boolean))].sort() as string[], [assets]);

  // Graph data
  const graphData = useMemo(() => {
    const assetIds = new Set(filteredAssets.map(a => a.id));
    const nodes: GraphNode[] = filteredAssets.map(a => {
      const saved = nodePositions.current.get(a.id);
      return {
        id: a.id,
        name: a.name,
        assetType: a.assetType,
        color: TYPE_COLORS[a.assetType] ?? '#6b7280',
        status: a.status,
        ipAddress: a.ipAddress,
        val: a.assetType === 'server' ? 6 : a.assetType === 'network' ? 5 : 3,
        ...(saved ? { fx: saved.fx, fy: saved.fy } : {}),
      };
    });
    const links: GraphLink[] = relations
      .filter(r => assetIds.has(r.sourceAssetId) && assetIds.has(r.targetAssetId))
      .map(r => ({ source: r.sourceAssetId, target: r.targetAssetId, relationType: r.relationType }));
    return { nodes, links };
  }, [filteredAssets, relations]);

  useEffect(() => {
    if (graphRef.current && viewMode === 'topology') {
      graphRef.current.d3Force('charge')?.strength(-400);
      graphRef.current.d3Force('link')?.distance(100);
      graphRef.current.d3Force('center')?.strength(0.03);
    }
  }, [graphData, viewMode]);

  // Handlers
  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      await client.cmdbDiscover();
      await fetchData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const handleDecommission = async () => {
    if (!selectedAsset || !confirm(`"${selectedAsset.name}" wirklich dekommissionieren?`)) return;
    try {
      await client.cmdbDeleteAsset(selectedAsset.id);
      setSelectedAsset(null);
      await fetchData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = () => {
    if (!selectedAsset) return;
    setEditFields({
      name: selectedAsset.name,
      status: selectedAsset.status,
      environment: selectedAsset.environment ?? '',
      tags: (selectedAsset.tags ?? []).join(', '),
      notes: selectedAsset.notes ?? '',
      purpose: selectedAsset.purpose ?? '',
    });
    setEditMode(true);
  };

  const handleSave = async () => {
    if (!selectedAsset) return;
    try {
      const updates: Record<string, unknown> = {};
      if (editFields.name !== selectedAsset.name) updates.name = editFields.name;
      if (editFields.status !== selectedAsset.status) updates.status = editFields.status;
      if (editFields.environment !== (selectedAsset.environment ?? '')) updates.environment = editFields.environment || null;
      if (editFields.purpose !== (selectedAsset.purpose ?? '')) updates.purpose = editFields.purpose || null;
      if (editFields.notes !== (selectedAsset.notes ?? '')) updates.notes = editFields.notes || null;
      const newTags = editFields.tags.split(',').map(t => t.trim()).filter(Boolean);
      if (JSON.stringify(newTags) !== JSON.stringify(selectedAsset.tags ?? [])) updates.tags = newTags;
      if (Object.keys(updates).length > 0) {
        await client.cmdbUpdateAsset(selectedAsset.id, updates);
        await fetchData();
        // Re-select to refresh detail
        const updated = { ...selectedAsset, ...updates } as CmdbAsset;
        if (updates.tags) updated.tags = updates.tags as string[];
        setSelectedAsset(updated);
      }
      setEditMode(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const formatDate = (d: string | null) => {
    if (!d) return '-';
    return new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  if (loading && assets.length === 0) {
    return <div className="flex items-center justify-center h-full"><div className="text-gray-400 animate-pulse">CMDB laden...</div></div>;
  }

  if (error && assets.length === 0) {
    return <div className="flex items-center justify-center h-full"><div className="text-red-400">Fehler: {error}</div></div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
        <h1 className="text-lg font-semibold text-gray-200">CMDB</h1>
        <div className="flex items-center gap-3">
          {stats && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>{stats.total} Assets</span>
              {Object.entries(stats.byType).map(([t, c]) => (
                <span key={t} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[t] ?? '#6b7280' }} />
                  {t}: {c}
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1 border border-[#2a2a2a] rounded overflow-hidden">
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1 text-xs ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
            >Tabelle</button>
            <button
              onClick={() => setViewMode('topology')}
              className={`px-3 py-1 text-xs ${viewMode === 'topology' ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
            >Topologie</button>
          </div>
          <button
            onClick={handleDiscover}
            disabled={discovering}
            className="px-3 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-600 disabled:opacity-50"
          >{discovering ? 'Discovering...' : 'Discovery'}</button>
          <button onClick={fetchData} className="px-3 py-1 text-xs bg-[#1f1f1f] text-gray-300 rounded hover:bg-[#2a2a2a]">
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#1f1f1f] flex-wrap">
        <input
          type="text"
          placeholder="Suche (Name, IP, Hostname)..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="px-3 py-1.5 text-sm bg-[#111111] border border-[#2a2a2a] rounded text-gray-200 placeholder-gray-500 w-56"
        />
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
          className="px-2 py-1.5 text-xs bg-[#111111] border border-[#2a2a2a] rounded text-gray-200"
        >
          <option value="all">Alle Typen</option>
          {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="px-2 py-1.5 text-xs bg-[#111111] border border-[#2a2a2a] rounded text-gray-200"
        >
          <option value="all">Alle Status</option>
          {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filterEnv}
          onChange={e => setFilterEnv(e.target.value)}
          className="px-2 py-1.5 text-xs bg-[#111111] border border-[#2a2a2a] rounded text-gray-200"
        >
          <option value="all">Alle Environments</option>
          {uniqueEnvs.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <span className="text-xs text-gray-500">{filteredAssets.length} Ergebnisse</span>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Table / Topology View */}
        <div className="flex-1 overflow-auto bg-[#0a0a0a]">
          {viewMode === 'table' ? (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#111111] z-10">
                <tr className="text-left text-xs text-gray-500 border-b border-[#1f1f1f]">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Typ</th>
                  <th className="px-4 py-2 font-medium">IP</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Env</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.map(asset => (
                  <tr
                    key={asset.id}
                    onClick={() => selectAsset(asset)}
                    className={`border-b border-[#1a1a1a] cursor-pointer hover:bg-[#1a1a1a] transition-colors ${selectedAsset?.id === asset.id ? 'bg-[#1a1a2a]' : ''}`}
                  >
                    <td className="px-4 py-2 text-gray-200 font-medium">{asset.name}</td>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-1.5 text-gray-300">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[asset.assetType] ?? '#6b7280' }} />
                        {asset.assetType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-400 font-mono text-xs">{asset.ipAddress ?? '-'}</td>
                    <td className="px-4 py-2">
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{ backgroundColor: (STATUS_COLORS[asset.status] ?? '#6b7280') + '22', color: STATUS_COLORS[asset.status] ?? '#6b7280' }}
                      >{asset.status}</span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{asset.sourceSkill ?? '-'}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{asset.environment ?? '-'}</td>
                  </tr>
                ))}
                {filteredAssets.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Keine Assets gefunden</td></tr>
                )}
              </tbody>
            </table>
          ) : (
            <div className="w-full h-full">
              {graphData.nodes.length > 0 ? (
                <ForceGraph2D
                  ref={graphRef}
                  graphData={graphData}
                  d3AlphaDecay={0.02}
                  d3VelocityDecay={0.3}
                  warmupTicks={80}
                  cooldownTicks={150}
                  enableNodeDrag={true}
                  onNodeDragEnd={(node: any) => {
                    node.fx = node.x; node.fy = node.y;
                    nodePositions.current.set(node.id, { fx: node.x, fy: node.y });
                  }}
                  nodeLabel={(node: any) => `${node.name} [${node.assetType}]${node.ipAddress ? `\n${node.ipAddress}` : ''}\nStatus: ${node.status}`}
                  nodeColor={(node: any) => node.color}
                  nodeRelSize={4}
                  nodeVal={(node: any) => node.val}
                  linkLabel={(link: any) => link.relationType}
                  linkColor={() => '#444'}
                  linkWidth={1.5}
                  linkDirectionalArrowLength={5}
                  linkDirectionalArrowRelPos={0.85}
                  onNodeClick={(node: any) => {
                    const asset = assets.find(a => a.id === node.id);
                    if (asset) selectAsset(asset);
                  }}
                  onBackgroundClick={() => { setSelectedAsset(null); setEditMode(false); }}
                  backgroundColor="#0a0a0a"
                  nodeCanvasObjectMode={() => 'replace'}
                  nodeCanvasObject={(node: any, ctx: any, globalScale: number) => {
                    const size = node.val * 1.5;
                    const isSelected = selectedAsset?.id === node.id;

                    // Node circle
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
                    ctx.fillStyle = node.color;
                    ctx.globalAlpha = node.status === 'active' ? 0.9 : 0.4;
                    ctx.fill();
                    ctx.globalAlpha = 1;

                    // Status ring
                    if (isSelected) {
                      ctx.strokeStyle = '#ffffff';
                      ctx.lineWidth = 2.5;
                      ctx.stroke();
                    } else if (node.status !== 'active') {
                      ctx.strokeStyle = STATUS_COLORS[node.status] ?? '#6b7280';
                      ctx.lineWidth = 1.5;
                      ctx.setLineDash([3, 3]);
                      ctx.stroke();
                      ctx.setLineDash([]);
                    }

                    // Label
                    const showLabel = isSelected || globalScale > 1.2;
                    if (showLabel) {
                      const fontSize = Math.max(9, 11 / globalScale);
                      ctx.font = `${fontSize}px sans-serif`;
                      ctx.textAlign = 'center';
                      ctx.textBaseline = 'top';
                      ctx.fillStyle = isSelected ? '#ffffff' : '#b0b0b0';
                      ctx.fillText(node.name.length > 20 ? node.name.slice(0, 18) + '...' : node.name, node.x, node.y + size + 3);
                    }
                  }}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Keine Assets {filterType !== 'all' ? `vom Typ "${filterType}"` : ''} {searchQuery ? `fuer "${searchQuery}"` : ''}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selectedAsset && (
          <div className="w-96 border-l border-[#1f1f1f] bg-[#111111] overflow-y-auto p-4">
            {detailLoading ? (
              <div className="text-gray-400 animate-pulse text-sm">Laden...</div>
            ) : editMode ? (
              /* Edit Mode */
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200">Bearbeiten</h2>
                  <button onClick={() => setEditMode(false)} className="text-gray-500 hover:text-gray-300 text-xs">X</button>
                </div>
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-gray-500 block mb-1">Name</label>
                    <input
                      type="text"
                      value={editFields.name ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, name: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Status</label>
                    <select
                      value={editFields.status ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, status: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    >
                      {['active', 'inactive', 'maintenance', 'decommissioned', 'unknown'].map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Environment</label>
                    <input
                      type="text"
                      value={editFields.environment ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, environment: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                      placeholder="production, staging, dev..."
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Tags (kommagetrennt)</label>
                    <input
                      type="text"
                      value={editFields.tags ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, tags: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Zweck</label>
                    <input
                      type="text"
                      value={editFields.purpose ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, purpose: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Notizen</label>
                    <textarea
                      value={editFields.notes ?? ''}
                      onChange={e => setEditFields(f => ({ ...f, notes: e.target.value }))}
                      rows={3}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm resize-none"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleSave} className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">
                      Speichern
                    </button>
                    <button onClick={() => setEditMode(false)} className="flex-1 px-3 py-1.5 bg-[#2a2a2a] text-gray-300 rounded text-xs hover:bg-[#333]">
                      Abbrechen
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Detail View */
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200 truncate">{selectedAsset.name}</h2>
                  <div className="flex gap-1">
                    <button onClick={startEdit} className="text-blue-400 hover:text-blue-300 text-xs">Bearbeiten</button>
                    <button onClick={() => { setSelectedAsset(null); setEditMode(false); }} className="text-gray-500 hover:text-gray-300 text-xs ml-2">X</button>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  {/* Type + Status */}
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TYPE_COLORS[selectedAsset.assetType] ?? '#6b7280' }} />
                      <span className="text-gray-300">{selectedAsset.assetType}</span>
                    </span>
                    <span
                      className="px-2 py-0.5 rounded-full text-xs"
                      style={{ backgroundColor: (STATUS_COLORS[selectedAsset.status] ?? '#6b7280') + '22', color: STATUS_COLORS[selectedAsset.status] ?? '#6b7280' }}
                    >{selectedAsset.status}</span>
                  </div>

                  {/* Core fields */}
                  <div className="bg-[#1a1a1a] rounded p-2 space-y-1">
                    {[
                      ['IP', selectedAsset.ipAddress],
                      ['Hostname', selectedAsset.hostname],
                      ['FQDN', selectedAsset.fqdn],
                      ['Environment', selectedAsset.environment],
                      ['Owner', selectedAsset.owner],
                      ['Source', selectedAsset.sourceSkill],
                      ['Source ID', selectedAsset.sourceId],
                      ['Zweck', selectedAsset.purpose],
                    ].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label as string} className="flex justify-between">
                        <span className="text-gray-500">{label}</span>
                        <span className="text-gray-200 truncate ml-2 max-w-[200px] text-right font-mono">{value as string}</span>
                      </div>
                    ))}
                  </div>

                  {/* Timestamps */}
                  <div className="bg-[#1a1a1a] rounded p-2 space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Erstellt</span>
                      <span className="text-gray-300">{formatDate(selectedAsset.createdAt)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Aktualisiert</span>
                      <span className="text-gray-300">{formatDate(selectedAsset.updatedAt)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Zuletzt gesehen</span>
                      <span className="text-gray-300">{formatDate(selectedAsset.lastSeenAt)}</span>
                    </div>
                  </div>

                  {/* Tags */}
                  {selectedAsset.tags && selectedAsset.tags.length > 0 && (
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500 mb-1">Tags</div>
                      <div className="flex flex-wrap gap-1">
                        {selectedAsset.tags.map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 bg-[#2a2a2a] text-gray-300 rounded text-[10px]">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  {selectedAsset.notes && (
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500 mb-1">Notizen</div>
                      <div className="text-gray-300 whitespace-pre-wrap">{selectedAsset.notes}</div>
                    </div>
                  )}

                  {/* Attributes */}
                  {Object.keys(selectedAsset.attributes ?? {}).length > 0 && (
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500 mb-1">Attribute</div>
                      {Object.entries(selectedAsset.attributes).map(([k, v]) => (
                        <div key={k} className="flex justify-between py-0.5">
                          <span className="text-gray-400 truncate mr-2">{k}</span>
                          <span className="text-gray-200 truncate max-w-[180px]">{String(v).slice(0, 60)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Relations */}
                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Relationen ({assetRelations.length})</div>
                    {assetRelations.length === 0 ? (
                      <div className="text-gray-600 text-[10px]">Keine Relationen</div>
                    ) : (
                      assetRelations.map(r => {
                        const isSource = r.sourceAssetId === selectedAsset.id;
                        const otherId = isSource ? r.targetAssetId : r.sourceAssetId;
                        const other = assets.find(a => a.id === otherId);
                        return (
                          <div key={r.id} className="flex items-center justify-between py-0.5">
                            <span className="text-gray-300 truncate text-[10px]">
                              {isSource ? '\u2192' : '\u2190'} {r.relationType} {isSource ? '\u2192' : '\u2190'} {other?.name ?? otherId.slice(0, 8)}
                            </span>
                            {r.autoDiscovered && <span className="text-gray-600 text-[10px]">auto</span>}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Change History */}
                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Aenderungen (letzte 10)</div>
                    {assetChanges.length === 0 ? (
                      <div className="text-gray-600 text-[10px]">Keine Aenderungen</div>
                    ) : (
                      assetChanges.slice(0, 10).map(c => (
                        <div key={c.id} className="py-1 border-b border-[#222] last:border-0">
                          <div className="flex justify-between">
                            <span className="text-gray-300 text-[10px] font-medium">{c.field}</span>
                            <span className="text-gray-600 text-[10px]">{formatDate(c.changedAt)}</span>
                          </div>
                          <div className="text-[10px]">
                            <span className="text-red-400/60 line-through">{c.oldValue ?? '-'}</span>
                            {' \u2192 '}
                            <span className="text-green-400/80">{c.newValue ?? '-'}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Decommission button */}
                  <button
                    onClick={handleDecommission}
                    className="w-full mt-2 px-3 py-1.5 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50"
                  >
                    Dekommissionieren
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
