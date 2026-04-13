'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useConfig } from '@/context/ConfigContext';
import type { KGEntity, KGRelation } from '@/lib/alfred-client';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const TYPE_COLORS: Record<string, string> = {
  person: '#60a5fa',
  location: '#34d399',
  item: '#fb923c',
  vehicle: '#f87171',
  event: '#a78bfa',
  metric: '#9ca3af',
  organization: '#fbbf24',
};

const TYPE_LABELS: Record<string, string> = {
  person: 'Personen',
  location: 'Orte',
  item: 'Items',
  vehicle: 'Fahrzeuge',
  event: 'Events',
  metric: 'Messwerte',
  organization: 'Organisationen',
};

const ENTITY_TYPES = ['person', 'location', 'item', 'vehicle', 'event', 'metric', 'organization'];

interface GraphNode {
  id: string;
  name: string;
  entityType: string;
  color: string;
  confidence: number;
  mentionCount: number;
  sources: string[];
  attributes: Record<string, unknown>;
  val: number;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  id: string;
  source: string;
  target: string;
  relationType: string;
  strength: number;
  context: string | null;
  mentionCount: number;
}

function shortLabel(name: string): string {
  if (name.startsWith('connection_')) return name.slice(11).replace(/_/g, ' ').slice(0, 20);
  if (name.length > 22) return name.slice(0, 20) + '...';
  return name;
}

export function KnowledgeGraphPage() {
  const { client } = useConfig();
  const [entities, setEntities] = useState<KGEntity[]>([]);
  const [relations, setRelations] = useState<KGRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<GraphLink | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const graphRef = useRef<any>(null);
  const nodePositions = useRef<Map<string, { fx: number; fy: number }>>(new Map());

  const fetchData = useCallback(async () => {
    try {
      const data = await client.fetchKnowledgeGraph();
      setEntities(data.entities);
      setRelations(data.relations);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { fetchData(); }, [fetchData]);
  // NO auto-refresh interval — manual only to prevent graph reset

  const graphData = useMemo(() => {
    let filteredEntities = entities;

    // Hide events by default (they dominate the graph)
    if (!showEvents) filteredEntities = filteredEntities.filter(e => e.entityType !== 'event');

    if (filterType !== 'all') {
      filteredEntities = filteredEntities.filter(e => e.entityType === filterType);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredEntities = filteredEntities.filter(e =>
        e.name.toLowerCase().includes(q) || e.normalizedName.includes(q),
      );
    }

    const entityIds = new Set(filteredEntities.map(e => e.id));

    const nodes: GraphNode[] = filteredEntities.map(e => {
      const saved = nodePositions.current.get(e.id);
      return {
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        color: TYPE_COLORS[e.entityType] ?? '#6b7280',
        confidence: e.confidence,
        mentionCount: e.mentionCount,
        sources: e.sources,
        attributes: e.attributes,
        val: Math.max(2, Math.min(10, e.mentionCount / 3 + e.confidence * 3)),
        ...(saved ? { fx: saved.fx, fy: saved.fy } : {}),
      };
    });

    const links: GraphLink[] = relations
      .filter(r => entityIds.has(r.sourceEntityId) && entityIds.has(r.targetEntityId))
      .map(r => ({
        id: r.id,
        source: r.sourceEntityId,
        target: r.targetEntityId,
        relationType: r.relationType,
        strength: r.strength,
        context: r.context,
        mentionCount: r.mentionCount,
      }));

    return { nodes, links };
  }, [entities, relations, filterType, searchQuery, showEvents]);

  useEffect(() => {
    if (graphRef.current) {
      graphRef.current.d3Force('charge')?.strength(-500);
      graphRef.current.d3Force('link')?.distance(120);
      graphRef.current.d3Force('center')?.strength(0.03);
    }
  }, [graphData]);

  const stats = useMemo(() => {
    const types: Record<string, number> = {};
    for (const e of entities) types[e.entityType] = (types[e.entityType] ?? 0) + 1;
    return { totalEntities: entities.length, totalRelations: relations.length, types };
  }, [entities, relations]);

  // Find connected entities for highlighting
  const connectedIds = useMemo(() => {
    if (!selectedNode) return new Set<string>();
    const ids = new Set<string>([selectedNode.id]);
    for (const r of relations) {
      if (r.sourceEntityId === selectedNode.id) ids.add(r.targetEntityId);
      if (r.targetEntityId === selectedNode.id) ids.add(r.sourceEntityId);
    }
    return ids;
  }, [selectedNode, relations]);

  const handleDeleteEntity = async (entityId: string) => {
    if (!confirm('Entity und alle verbundenen Relations löschen?')) return;
    const ok = await client.deleteKgEntity(entityId);
    if (ok) { setSelectedNode(null); fetchData(); }
  };

  const handleDeleteRelation = async (relationId: string) => {
    if (!confirm('Relation löschen?')) return;
    const ok = await client.deleteKgRelation(relationId);
    if (ok) { setSelectedLink(null); fetchData(); }
  };

  const handleUpdateEntity = async () => {
    if (!selectedNode) return;
    const updates: Record<string, unknown> = {};
    if (editName && editName !== selectedNode.name) updates.name = editName;
    if (editType && editType !== selectedNode.entityType) updates.entityType = editType;
    if (Object.keys(updates).length === 0) { setEditMode(false); return; }
    const ok = await client.updateKgEntity(selectedNode.id, updates);
    if (ok) { setEditMode(false); fetchData(); }
  };

  const handleUpdateRelation = async (field: string, value: unknown) => {
    if (!selectedLink) return;
    const ok = await client.updateKgRelation(selectedLink.id, { [field]: value });
    if (ok) fetchData();
  };

  const startEdit = () => {
    if (!selectedNode) return;
    setEditName(selectedNode.name);
    setEditType(selectedNode.entityType);
    setEditMode(true);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><div className="text-gray-400 animate-pulse">Knowledge Graph laden...</div></div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-full"><div className="text-red-400">Fehler: {error}</div></div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
        <h1 className="text-lg font-semibold text-gray-200">Knowledge Graph</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {stats.totalEntities} Entities | {stats.totalRelations} Relations
          </span>
          <button onClick={fetchData} className="px-3 py-1 text-xs bg-[#1f1f1f] text-gray-300 rounded hover:bg-[#2a2a2a]">
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#1f1f1f] flex-wrap">
        <input
          type="text"
          placeholder="Suche..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="px-3 py-1.5 text-sm bg-[#111111] border border-[#2a2a2a] rounded text-gray-200 placeholder-gray-500 w-48"
        />
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => { setFilterType('all'); setShowEvents(false); }}
            className={`px-2 py-1 text-xs rounded ${filterType === 'all' && !showEvents ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
          >
            Alle (ohne Events)
          </button>
          <button
            onClick={() => { setFilterType('all'); setShowEvents(true); }}
            className={`px-2 py-1 text-xs rounded ${filterType === 'all' && showEvents ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
          >
            Alle + Events
          </button>
          {Object.entries(stats.types).map(([type, count]) => (
            <button
              key={type}
              onClick={() => { setFilterType(type); setShowEvents(type === 'event'); }}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${filterType === type ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] ?? '#6b7280' }} />
              {TYPE_LABELS[type] ?? type} ({count})
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph */}
        <div className="flex-1 relative bg-[#0a0a0a]">
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
              nodeLabel={(node: any) => `${node.name} [${node.entityType}]\nConfidence: ${(node.confidence * 100).toFixed(0)}% | Mentions: ${node.mentionCount}`}
              nodeColor={(node: any) => node.color}
              nodeRelSize={4}
              nodeVal={(node: any) => node.val}
              linkLabel={(link: any) => `${link.relationType} (${(link.strength * 100).toFixed(0)}%)`}
              linkColor={(link: any) => {
                if (selectedLink?.id === link.id) return '#60a5fa';
                if (selectedNode && connectedIds.has((link.source as any)?.id || link.source) && connectedIds.has((link.target as any)?.id || link.target)) return '#666';
                if (selectedNode) return '#222';
                return '#444';
              }}
              linkWidth={(link: any) => selectedLink?.id === link.id ? 3 : Math.max(0.5, link.strength * 2)}
              linkDirectionalArrowLength={5}
              linkDirectionalArrowRelPos={0.85}
              linkDirectionalParticles={(link: any) => link.strength > 0.7 ? 2 : 0}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleColor={() => '#60a5fa'}
              onNodeClick={(node: any) => { console.log('[KG] Node clicked:', node.name, node.id); setSelectedNode(node); setSelectedLink(null); setEditMode(false); }}
              onLinkClick={(link: any) => { setSelectedLink(link); setSelectedNode(null); setEditMode(false); }}
              onBackgroundClick={() => { setSelectedNode(null); setSelectedLink(null); setEditMode(false); }}
              backgroundColor="#0a0a0a"
              nodeCanvasObjectMode={() => 'replace'}
              nodePointerAreaPaint={(node: any, color: string, ctx: any) => {
                const size = node.val * 1.5;
                ctx.beginPath();
                ctx.arc(node.x, node.y, Math.max(size, 6), 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
              }}
              nodeCanvasObject={(node: any, ctx: any, globalScale: number) => {
                const label = shortLabel(node.name);
                const size = node.val * 1.5;
                const isConnected = selectedNode ? connectedIds.has(node.id) : true;
                const isSelected = selectedNode?.id === node.id;

                ctx.beginPath();
                ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
                ctx.fillStyle = node.color;
                ctx.globalAlpha = isSelected ? 1 : isConnected ? 0.85 : 0.2;
                ctx.fill();
                ctx.globalAlpha = 1;

                if (isSelected) {
                  ctx.strokeStyle = '#ffffff';
                  ctx.lineWidth = 2.5;
                  ctx.stroke();
                }

                // Labels: zoom <1 = none, 1-2 = only selected+connected, >2 = all
                const showLabel = isSelected
                  || (globalScale > 1 && isConnected && node.entityType !== 'event')
                  || globalScale > 2;
                if (showLabel) {
                  const fontSize = Math.max(9, 11 / globalScale);
                  ctx.font = `${fontSize}px sans-serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  ctx.fillStyle = isSelected ? '#ffffff' : isConnected ? '#c0c0c0' : '#666';
                  ctx.fillText(label, node.x, node.y + size + 3);
                }
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              Keine Entities {filterType !== 'all' ? `vom Typ "${filterType}"` : ''} {searchQuery ? `für "${searchQuery}"` : ''}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {(selectedNode || selectedLink) && (
          <div className="w-80 shrink-0 border-l border-[#1f1f1f] bg-[#111111] overflow-y-auto p-4">
            {selectedNode && !editMode && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200 truncate">{selectedNode.name}</h2>
                  <div className="flex gap-1">
                    <button onClick={startEdit} className="text-blue-400 hover:text-blue-300 text-xs">Bearbeiten</button>
                    <button onClick={() => setSelectedNode(null)} className="text-gray-500 hover:text-gray-300 text-xs ml-2">✕</button>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                    <span className="text-gray-400">{selectedNode.entityType}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500">Confidence</div>
                      <div className="text-gray-200 font-medium">{(selectedNode.confidence * 100).toFixed(0)}%</div>
                    </div>
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500">Erwähnungen</div>
                      <div className="text-gray-200 font-medium">{selectedNode.mentionCount}×</div>
                    </div>
                  </div>

                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Quellen</div>
                    <div className="flex flex-wrap gap-1">
                      {selectedNode.sources.map((s: string) => (
                        <span key={s} className="px-1.5 py-0.5 bg-[#2a2a2a] text-gray-300 rounded text-[10px]">{s}</span>
                      ))}
                    </div>
                  </div>

                  {Object.keys(selectedNode.attributes).length > 0 && (
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500 mb-1">Attribute</div>
                      {Object.entries(selectedNode.attributes).map(([k, v]) => (
                        <div key={k} className="flex justify-between py-0.5">
                          <span className="text-gray-400 truncate mr-2">{k}</span>
                          <span className="text-gray-200 truncate">{String(v).slice(0, 50)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Verbindungen ({relations.filter(r => r.sourceEntityId === selectedNode.id || r.targetEntityId === selectedNode.id).length})</div>
                    {relations
                      .filter(r => r.sourceEntityId === selectedNode.id || r.targetEntityId === selectedNode.id)
                      .slice(0, 20)
                      .map(r => {
                        const otherId = r.sourceEntityId === selectedNode.id ? r.targetEntityId : r.sourceEntityId;
                        const other = entities.find(e => e.id === otherId);
                        const direction = r.sourceEntityId === selectedNode.id ? '→' : '←';
                        return (
                          <div key={r.id} className="flex items-center justify-between py-0.5 group">
                            <span className="text-gray-300 truncate text-[10px]">{direction} {r.relationType} → {other?.name ?? '?'}</span>
                            <span className="text-gray-500 text-[10px]">{(r.strength * 100).toFixed(0)}%</span>
                          </div>
                        );
                      })}
                  </div>

                  <button
                    onClick={() => handleDeleteEntity(selectedNode.id)}
                    className="w-full mt-2 px-3 py-1.5 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50"
                  >
                    Entity löschen
                  </button>
                </div>
              </div>
            )}

            {/* Edit Mode */}
            {selectedNode && editMode && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200">Bearbeiten</h2>
                  <button onClick={() => setEditMode(false)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
                </div>
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-gray-500 block mb-1">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 block mb-1">Typ</label>
                    <select
                      value={editType}
                      onChange={e => setEditType(e.target.value)}
                      className="w-full px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    >
                      {ENTITY_TYPES.map(t => (
                        <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleUpdateEntity} className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">
                      Speichern
                    </button>
                    <button onClick={() => setEditMode(false)} className="flex-1 px-3 py-1.5 bg-[#2a2a2a] text-gray-300 rounded text-xs hover:bg-[#333]">
                      Abbrechen
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Relation Detail */}
            {selectedLink && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200">Relation</h2>
                  <button onClick={() => setSelectedLink(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Typ</div>
                    <input
                      type="text"
                      defaultValue={selectedLink.relationType}
                      onBlur={e => { if (e.target.value !== selectedLink.relationType) handleUpdateRelation('relationType', e.target.value); }}
                      className="w-full px-2 py-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded text-gray-200 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500">Stärke</div>
                      <div className="text-gray-200">{(selectedLink.strength * 100).toFixed(0)}%</div>
                    </div>
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500">Erwähnungen</div>
                      <div className="text-gray-200">{selectedLink.mentionCount}×</div>
                    </div>
                  </div>

                  {selectedLink.context && (
                    <div className="bg-[#1a1a1a] rounded p-2">
                      <div className="text-gray-500">Kontext</div>
                      <div className="text-gray-200">{selectedLink.context}</div>
                    </div>
                  )}

                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500">Von</div>
                    <div className="text-gray-200">{entities.find(e => e.id === ((selectedLink.source as any)?.id || selectedLink.source))?.name ?? '?'}</div>
                    <div className="text-gray-500 mt-1">Nach</div>
                    <div className="text-gray-200">{entities.find(e => e.id === ((selectedLink.target as any)?.id || selectedLink.target))?.name ?? '?'}</div>
                  </div>

                  <button
                    onClick={() => handleDeleteRelation(selectedLink.id)}
                    className="w-full mt-2 px-3 py-1.5 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50"
                  >
                    Relation löschen
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
