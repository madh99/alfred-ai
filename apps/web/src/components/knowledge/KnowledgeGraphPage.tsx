'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useConfig } from '@/context/ConfigContext';
import type { KGEntity, KGRelation } from '@/lib/alfred-client';

// Dynamic import to avoid SSR issues with canvas-based library
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

// Entity type → color mapping
const TYPE_COLORS: Record<string, string> = {
  person: '#60a5fa',    // blue
  location: '#34d399',  // green
  item: '#fb923c',      // orange
  vehicle: '#f87171',   // red
  event: '#a78bfa',     // purple
  metric: '#9ca3af',    // gray
  organization: '#fbbf24', // yellow
};

// Entity type → label
const TYPE_LABELS: Record<string, string> = {
  person: 'Personen',
  location: 'Orte',
  item: 'Items',
  vehicle: 'Fahrzeuge',
  event: 'Events',
  metric: 'Messwerte',
  organization: 'Organisationen',
};

interface GraphNode {
  id: string;
  name: string;
  entityType: string;
  color: string;
  confidence: number;
  mentionCount: number;
  sources: string[];
  attributes: Record<string, unknown>;
  val: number; // node size
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
  const graphRef = useRef<any>(null);

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

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 60_000);
    return () => clearInterval(timer);
  }, [fetchData]);

  // Build graph data
  const graphData = useMemo(() => {
    let filteredEntities = entities;

    if (filterType !== 'all') {
      filteredEntities = entities.filter(e => e.entityType === filterType);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredEntities = filteredEntities.filter(e =>
        e.name.toLowerCase().includes(q) || e.normalizedName.includes(q),
      );
    }

    const entityIds = new Set(filteredEntities.map(e => e.id));

    const nodes: GraphNode[] = filteredEntities.map(e => ({
      id: e.id,
      name: e.name,
      entityType: e.entityType,
      color: TYPE_COLORS[e.entityType] ?? '#6b7280',
      confidence: e.confidence,
      mentionCount: e.mentionCount,
      sources: e.sources,
      attributes: e.attributes,
      val: Math.max(2, Math.min(10, e.mentionCount / 2 + e.confidence * 3)),
    }));

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
  }, [entities, relations, filterType, searchQuery]);

  // Configure force engine for better spread after data loads
  useEffect(() => {
    if (graphRef.current) {
      graphRef.current.d3Force('charge')?.strength(-200);
      graphRef.current.d3Force('link')?.distance(80);
      graphRef.current.d3Force('center')?.strength(0.05);
    }
  }, [graphData]);

  // Stats
  const stats = useMemo(() => {
    const types: Record<string, number> = {};
    for (const e of entities) types[e.entityType] = (types[e.entityType] ?? 0) + 1;
    return { totalEntities: entities.length, totalRelations: relations.length, types };
  }, [entities, relations]);

  const handleDeleteEntity = async (entityId: string) => {
    if (!confirm('Entity und alle verbundenen Relations löschen?')) return;
    const ok = await client.deleteKgEntity(entityId);
    if (ok) {
      setSelectedNode(null);
      fetchData();
    }
  };

  const handleDeleteRelation = async (relationId: string) => {
    if (!confirm('Relation löschen?')) return;
    const ok = await client.deleteKgRelation(relationId);
    if (ok) {
      setSelectedLink(null);
      fetchData();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400 animate-pulse">Knowledge Graph laden...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-400">Fehler: {error}</div>
      </div>
    );
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
          <button
            onClick={fetchData}
            className="px-3 py-1 text-xs bg-[#1f1f1f] text-gray-300 rounded hover:bg-[#2a2a2a] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#1f1f1f]">
        <input
          type="text"
          placeholder="Suche..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="px-3 py-1.5 text-sm bg-[#111111] border border-[#2a2a2a] rounded text-gray-200 placeholder-gray-500 w-48"
        />
        <div className="flex gap-1">
          <button
            onClick={() => setFilterType('all')}
            className={`px-2 py-1 text-xs rounded ${filterType === 'all' ? 'bg-blue-600 text-white' : 'bg-[#1f1f1f] text-gray-400 hover:bg-[#2a2a2a]'}`}
          >
            Alle
          </button>
          {Object.entries(stats.types).map(([type, count]) => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
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
              // Force parameters: spread nodes out, don't cluster
              d3AlphaDecay={0.02}
              d3VelocityDecay={0.3}
              dagMode={undefined}
              warmupTicks={50}
              cooldownTicks={100}
              // Node interaction
              enableNodeDrag={true}
              onNodeDragEnd={(node: any) => { node.fx = node.x; node.fy = node.y; }}
              nodeLabel={(node: any) => `${node.name} [${node.entityType}]\nConfidence: ${(node.confidence * 100).toFixed(0)}% | Mentions: ${node.mentionCount}`}
              nodeColor={(node: any) => node.color}
              nodeRelSize={4}
              nodeVal={(node: any) => node.val}
              // Link styling
              linkLabel={(link: any) => `${link.relationType} (${(link.strength * 100).toFixed(0)}%)`}
              linkColor={(link: any) => selectedLink?.id === link.id ? '#60a5fa' : '#444444'}
              linkWidth={(link: any) => selectedLink?.id === link.id ? 3 : Math.max(0.5, link.strength * 2)}
              linkDirectionalArrowLength={5}
              linkDirectionalArrowRelPos={0.85}
              linkDirectionalParticles={(link: any) => link.strength > 0.7 ? 2 : 0}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleColor={() => '#60a5fa'}
              // Events
              onNodeClick={(node: any) => { setSelectedNode(node); setSelectedLink(null); }}
              onLinkClick={(link: any) => { setSelectedLink(link); setSelectedNode(null); }}
              onBackgroundClick={() => { setSelectedNode(null); setSelectedLink(null); }}
              backgroundColor="#0a0a0a"
              // Custom node rendering
              nodeCanvasObjectMode={() => 'replace'}
              nodeCanvasObject={(node: any, ctx: any, globalScale: number) => {
                const label = node.name.length > 25 ? node.name.slice(0, 23) + '...' : node.name;
                const size = node.val * 1.5;

                // Node circle
                ctx.beginPath();
                ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
                ctx.fillStyle = node.color;
                ctx.globalAlpha = selectedNode?.id === node.id ? 1 : 0.75;
                ctx.fill();
                ctx.globalAlpha = 1;

                // Selected highlight ring
                if (selectedNode?.id === node.id) {
                  ctx.strokeStyle = '#ffffff';
                  ctx.lineWidth = 2.5;
                  ctx.stroke();
                }

                // Label — only show when zoomed in enough or for selected/hovered
                if (globalScale > 1.5 || selectedNode?.id === node.id || node.mentionCount > 5) {
                  const fontSize = Math.max(9, 11 / globalScale);
                  ctx.font = `${fontSize}px sans-serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  ctx.fillStyle = selectedNode?.id === node.id ? '#ffffff' : '#c0c0c0';
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
          <div className="w-80 border-l border-[#1f1f1f] bg-[#111111] overflow-y-auto p-4">
            {selectedNode && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200">{selectedNode.name}</h2>
                  <button onClick={() => setSelectedNode(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
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
                          <span className="text-gray-400">{k}</span>
                          <span className="text-gray-200">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Connected relations */}
                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500 mb-1">Verbindungen</div>
                    {relations
                      .filter(r => r.sourceEntityId === selectedNode.id || r.targetEntityId === selectedNode.id)
                      .map(r => {
                        const otherId = r.sourceEntityId === selectedNode.id ? r.targetEntityId : r.sourceEntityId;
                        const other = entities.find(e => e.id === otherId);
                        const direction = r.sourceEntityId === selectedNode.id ? '→' : '←';
                        return (
                          <div key={r.id} className="flex items-center justify-between py-0.5">
                            <span className="text-gray-300 truncate">{direction} {r.relationType} → {other?.name ?? '?'}</span>
                            <span className="text-gray-500 text-[10px]">{(r.strength * 100).toFixed(0)}%</span>
                          </div>
                        );
                      })}
                  </div>

                  <button
                    onClick={() => handleDeleteEntity(selectedNode.id)}
                    className="w-full mt-2 px-3 py-1.5 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50 transition-colors"
                  >
                    Entity löschen
                  </button>
                </div>
              </div>
            )}

            {selectedLink && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-200">Relation</h2>
                  <button onClick={() => setSelectedLink(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="bg-[#1a1a1a] rounded p-2">
                    <div className="text-gray-500">Typ</div>
                    <div className="text-gray-200 font-medium">{selectedLink.relationType}</div>
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
                    className="w-full mt-2 px-3 py-1.5 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50 transition-colors"
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
