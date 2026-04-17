'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import type { ServiceDetail, ServiceComponent, FailureMode } from '@/types/api';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#22c55e',
  degraded: '#eab308',
  down: '#ef4444',
  unknown: '#6b7280',
};

const CRITICALITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-gray-500/20 text-gray-400',
};

const CRITICALITY_OPTIONS = ['critical', 'high', 'medium', 'low'];
const ROLE_OPTIONS = ['frontend', 'backend', 'database', 'cache', 'proxy', 'queue', 'storage', 'monitoring', 'other'];
const IMPACT_OPTIONS = ['down', 'degraded', 'minor', 'none'];

/* ------------------------------------------------------------------ */
/*  Graph types                                                        */
/* ------------------------------------------------------------------ */

interface GraphNode {
  id: string;
  name: string;
  role: string;
  ip?: string;
  healthStatus?: string;
  required: boolean;
  color: string;
  val: number;
  component: ServiceComponent;
}

interface GraphLink {
  source: string;
  target: string;
}

/* ------------------------------------------------------------------ */
/*  Wizard step types                                                   */
/* ------------------------------------------------------------------ */

interface WizardComponent {
  name: string;
  role: string;
  assetId?: string;
  required: boolean;
  failureImpact: string;
  failureDescription?: string;
  ports?: string;
  dns?: string;
  ip?: string;
}

interface WizardFailureMode {
  name: string;
  trigger: string;
  affectedComponents: string[];
  serviceImpact: string;
  cascadeEffects?: string;
  estimatedRecoveryMinutes?: number;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ServicesPage() {
  const { client } = useConfig();
  const [services, setServices] = useState<ServiceDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<ServiceComponent | null>(null);
  const [expandedFailure, setExpandedFailure] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [docGenerating, setDocGenerating] = useState(false);
  const [linkedDocs, setLinkedDocs] = useState<any[]>([]);
  const graphRef = useRef<any>(null);

  const selected = useMemo(() => services.find(s => s.id === selectedId) ?? null, [services, selectedId]);

  /* ── Fetch ── */

  const fetchServices = useCallback(async () => {
    try {
      const data = await client.fetchServices();
      setServices(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  // Auto-refresh every 30s
  useEffect(() => {
    const iv = setInterval(fetchServices, 30_000);
    return () => clearInterval(iv);
  }, [fetchServices]);

  // Fetch linked docs when service changes
  useEffect(() => {
    if (!selected) { setLinkedDocs([]); return; }
    (async () => {
      try {
        const res = await fetch(
          `${(client as any).baseUrl}/api/docs/search?q=service:${selected.id}`,
          { headers: (client as any).token ? { Authorization: `Bearer ${(client as any).token}` } : {} },
        );
        if (res.ok) setLinkedDocs(await res.json());
      } catch { /* ignore */ }
    })();
  }, [selected, client]);

  /* ── Graph data ── */

  const graphData = useMemo(() => {
    if (!selected) return { nodes: [], links: [] };
    const nodes: GraphNode[] = selected.components.map((c, i) => ({
      id: c.name,
      name: c.name,
      role: c.role,
      ip: c.ip,
      healthStatus: c.healthStatus,
      required: c.required,
      color: HEALTH_COLORS[c.healthStatus ?? 'unknown'] ?? HEALTH_COLORS.unknown,
      val: c.required ? 10 : 6,
      component: c,
    }));

    const links: GraphLink[] = [];
    for (const c of selected.components) {
      if (c.dependsOn) {
        for (const dep of c.dependsOn) {
          if (nodes.some(n => n.id === dep)) {
            links.push({ source: c.name, target: dep });
          }
        }
      }
    }

    return { nodes, links };
  }, [selected]);

  useEffect(() => {
    if (graphRef.current && graphData.nodes.length > 0) {
      graphRef.current.d3Force('charge')?.strength(-300);
      graphRef.current.d3Force('link')?.distance(100);
    }
  }, [graphData]);

  /* ── Actions ── */

  const handleDelete = async () => {
    if (!selected || !confirm(`Service "${selected.name}" wirklich loeschen?`)) return;
    const ok = await client.deleteService(selected.id);
    if (ok) { setSelectedId(null); fetchServices(); }
  };

  const handleGenerateDocs = async () => {
    if (!selected) return;
    setDocGenerating(true);
    try {
      await client.generateServiceDocs(selected.id);
    } catch { /* ignore */ }
    setDocGenerating(false);
  };

  /* ── Loading / Error ── */

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0a] text-gray-400">
        <div className="animate-pulse">Services werden geladen...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0a]">
        <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 text-center">
          <p className="text-red-400 mb-2">Fehler: {error}</p>
          <button onClick={fetchServices} className="text-sm text-blue-400 hover:text-blue-300">Erneut versuchen</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-[#0a0a0a]">
      {/* ── Service List (Left Panel) ── */}
      <div className="w-[250px] border-r border-[#1f1f1f] flex flex-col overflow-hidden">
        <div className="p-3 border-b border-[#1f1f1f] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Services</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="text-xs bg-blue-500/20 text-blue-400 px-2 py-1 rounded hover:bg-blue-500/30"
          >+ Neu</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {services.length === 0 && (
            <p className="text-xs text-gray-500 text-center mt-4">Keine Services vorhanden</p>
          )}
          {services.map(s => (
            <button
              key={s.id}
              onClick={() => { setSelectedId(s.id); setSelectedComponent(null); setExpandedFailure(null); }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                selectedId === s.id
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-200',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: HEALTH_COLORS[s.healthStatus] ?? HEALTH_COLORS.unknown }}
                />
                <span className="truncate">{s.name}</span>
              </div>
              {s.criticality && (
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded mt-1 inline-block', CRITICALITY_COLORS[s.criticality] ?? CRITICALITY_COLORS.low)}>
                  {s.criticality}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Detail Panel (Right) ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Service auswaehlen oder neuen erstellen
          </div>
        ) : (
          <div className="space-y-6 max-w-5xl">
            {/* Header */}
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: HEALTH_COLORS[selected.healthStatus] ?? HEALTH_COLORS.unknown }}
                  />
                  <h1 className="text-xl font-bold text-gray-200">{selected.name}</h1>
                  {selected.criticality && (
                    <span className={clsx('text-xs px-2 py-0.5 rounded', CRITICALITY_COLORS[selected.criticality] ?? CRITICALITY_COLORS.low)}>
                      {selected.criticality}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerateDocs}
                    disabled={docGenerating}
                    className="text-xs bg-purple-500/20 text-purple-400 px-3 py-1.5 rounded hover:bg-purple-500/30 disabled:opacity-50"
                  >{docGenerating ? 'Generiert...' : 'Doku generieren'}</button>
                  <button
                    onClick={handleDelete}
                    className="text-xs bg-red-500/20 text-red-400 px-3 py-1.5 rounded hover:bg-red-500/30"
                  >Loeschen</button>
                </div>
              </div>
              {selected.description && <p className="text-sm text-gray-400 mt-2">{selected.description}</p>}
              <div className="flex gap-4 mt-3 text-xs text-gray-500">
                {selected.environment && <span>Env: {selected.environment}</span>}
                {selected.owner && <span>Owner: {selected.owner}</span>}
                {selected.url && <a href={selected.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">{selected.url}</a>}
              </div>
            </div>

            {/* Component Graph */}
            {graphData.nodes.length > 0 && (
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Komponenten-Graph</h2>
                <div className="flex gap-4">
                  <div className={clsx('h-[400px] rounded-lg overflow-hidden bg-[#0a0a0a] border border-[#1f1f1f]', selectedComponent ? 'flex-1' : 'w-full')}>
                    <ForceGraph2D
                      ref={graphRef}
                      graphData={graphData}
                      width={selectedComponent ? 500 : 800}
                      height={400}
                      backgroundColor="#0a0a0a"
                      nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                        const n = node as GraphNode;
                        const r = n.required ? 10 : 6;
                        // Circle
                        ctx.beginPath();
                        ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
                        ctx.fillStyle = n.color;
                        ctx.fill();
                        if (selectedComponent?.name === n.name) {
                          ctx.strokeStyle = '#fff';
                          ctx.lineWidth = 2;
                          ctx.stroke();
                        }
                        // Label
                        if (globalScale > 0.6) {
                          const label = `${n.name}${n.ip ? '\n' + n.ip : ''}\n${n.role}`;
                          const lines = label.split('\n');
                          ctx.font = `${Math.max(3, 10 / globalScale)}px Sans-Serif`;
                          ctx.textAlign = 'center';
                          ctx.textBaseline = 'top';
                          ctx.fillStyle = '#d1d5db';
                          lines.forEach((line, i) => {
                            ctx.fillText(line, node.x!, node.y! + r + 2 + i * (12 / globalScale));
                          });
                        }
                      }}
                      linkColor={() => '#333'}
                      linkDirectionalArrowLength={4}
                      linkDirectionalArrowRelPos={1}
                      onNodeClick={(node: any) => {
                        const n = node as GraphNode;
                        setSelectedComponent(n.component);
                      }}
                    />
                  </div>

                  {/* Component Detail Panel */}
                  {selectedComponent && (
                    <div className="w-[280px] bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-4 space-y-3 overflow-y-auto max-h-[400px]">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-gray-200">{selectedComponent.name}</h3>
                        <button onClick={() => setSelectedComponent(null)} className="text-gray-500 hover:text-gray-300 text-xs">X</button>
                      </div>
                      <div className="space-y-2 text-xs">
                        <InfoRow label="Rolle" value={selectedComponent.role} />
                        {selectedComponent.ip && <InfoRow label="IP" value={selectedComponent.ip} />}
                        {selectedComponent.ports && selectedComponent.ports.length > 0 && (
                          <InfoRow label="Ports" value={selectedComponent.ports.join(', ')} />
                        )}
                        {selectedComponent.dns && <InfoRow label="DNS" value={selectedComponent.dns} />}
                        {selectedComponent.protocol && <InfoRow label="Protokoll" value={selectedComponent.protocol} />}
                        <div>
                          <span className="text-gray-500">Health: </span>
                          <span style={{ color: HEALTH_COLORS[selectedComponent.healthStatus ?? 'unknown'] }}>
                            {selectedComponent.healthStatus ?? 'unknown'}
                          </span>
                        </div>
                        {selectedComponent.healthReason && <InfoRow label="Grund" value={selectedComponent.healthReason} />}
                        <div>
                          <span className="text-gray-500">Failure Impact: </span>
                          <span className={clsx(
                            selectedComponent.failureImpact === 'down' ? 'text-red-400' :
                            selectedComponent.failureImpact === 'degraded' ? 'text-yellow-400' : 'text-gray-400',
                          )}>{selectedComponent.failureImpact}</span>
                        </div>
                        {selectedComponent.failureDescription && (
                          <p className="text-gray-400">{selectedComponent.failureDescription}</p>
                        )}
                        {selectedComponent.required && (
                          <span className="inline-block bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-[10px]">Required</span>
                        )}
                        {selectedComponent.assetId && (
                          <a
                            href={`/alfred/cmdb/?asset=${selectedComponent.assetId}`}
                            className="block text-blue-400 hover:text-blue-300 text-xs mt-2"
                          >CMDB Asset anzeigen &rarr;</a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Failure Modes */}
            {selected.failureModes && selected.failureModes.length > 0 && (
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Failure Modes</h2>
                <div className="space-y-2">
                  {selected.failureModes.map((fm, i) => (
                    <div key={i} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-3">
                      <button
                        onClick={() => setExpandedFailure(expandedFailure === i ? null : i)}
                        className="w-full text-left flex items-center gap-2"
                      >
                        <span>{fm.serviceImpact === 'down' ? '\uD83D\uDD34' : '\uD83D\uDFE1'}</span>
                        <span className="text-sm text-gray-200 font-medium">{fm.name}</span>
                        <span className="text-xs text-gray-500 ml-auto">{fm.trigger}</span>
                      </button>
                      {expandedFailure === i && (
                        <div className="mt-3 pt-3 border-t border-[#1f1f1f] space-y-2 text-xs">
                          <InfoRow label="Betroffene Komponenten" value={fm.affectedComponents.join(', ')} />
                          <InfoRow label="Service Impact" value={fm.serviceImpact} />
                          {fm.cascadeEffects && fm.cascadeEffects.length > 0 && (
                            <InfoRow label="Kaskadeneffekte" value={fm.cascadeEffects.join(', ')} />
                          )}
                          {fm.estimatedRecoveryMinutes && (
                            <InfoRow label="Recovery Zeit" value={`~${fm.estimatedRecoveryMinutes} Min.`} />
                          )}
                          {fm.runbookId && <InfoRow label="Runbook" value={fm.runbookId} />}
                          {fm.sopId && <InfoRow label="SOP" value={fm.sopId} />}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Linked Documents */}
            {linkedDocs.length > 0 && (
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Verknuepfte Dokumente</h2>
                <div className="space-y-1">
                  {linkedDocs.map((doc: any) => (
                    <a
                      key={doc.id}
                      href={`/alfred/docs/?doc=${doc.id}`}
                      className="block text-sm text-blue-400 hover:text-blue-300 py-1"
                    >{doc.title || doc.docType}</a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Create Service Dialog ── */}
      {showCreate && (
        <CreateServiceDialog
          client={client}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchServices(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  InfoRow helper                                                     */
/* ------------------------------------------------------------------ */

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}: </span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Service Dialog (4-step wizard)                              */
/* ------------------------------------------------------------------ */

function CreateServiceDialog({ client, onClose, onCreated }: { client: any; onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [criticality, setCriticality] = useState('medium');
  const [components, setComponents] = useState<WizardComponent[]>([]);
  const [failureModes, setFailureModes] = useState<WizardFailureMode[]>([]);
  const [cmdbAssets, setCmdbAssets] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);

  // Load CMDB assets for step 2
  useEffect(() => {
    (async () => {
      try {
        const assets = await client.cmdbListAssets();
        setCmdbAssets(assets);
      } catch { /* ignore */ }
    })();
  }, [client]);

  const addComponent = () => {
    setComponents([...components, { name: '', role: 'backend', required: false, failureImpact: 'degraded' }]);
  };

  const updateComponent = (idx: number, patch: Partial<WizardComponent>) => {
    setComponents(components.map((c, i) => i === idx ? { ...c, ...patch } : c));
  };

  const removeComponent = (idx: number) => {
    setComponents(components.filter((_, i) => i !== idx));
  };

  const addFailureMode = () => {
    setFailureModes([...failureModes, { name: '', trigger: '', affectedComponents: [], serviceImpact: 'degraded' }]);
  };

  const updateFailureMode = (idx: number, patch: Partial<WizardFailureMode>) => {
    setFailureModes(failureModes.map((fm, i) => i === idx ? { ...fm, ...patch } : fm));
  };

  const removeFailureMode = (idx: number) => {
    setFailureModes(failureModes.filter((_, i) => i !== idx));
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await client.createService({
        name,
        description,
        criticality,
        components: components.map(c => ({
          ...c,
          ports: c.ports ? c.ports.split(',').map((p: string) => parseInt(p.trim(), 10)).filter((n: number) => !isNaN(n)) : [],
        })),
        failureModes: failureModes.map(fm => ({
          ...fm,
          cascadeEffects: fm.cascadeEffects ? fm.cascadeEffects.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
        })),
      });
      onCreated();
    } catch (err) {
      alert('Fehler: ' + (err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-[700px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-200">Neuer Service</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">X</button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-2 mb-6">
          {[1, 2, 3, 4].map(s => (
            <div key={s} className={clsx(
              'flex-1 h-1 rounded-full',
              s <= step ? 'bg-blue-500' : 'bg-[#1f1f1f]',
            )} />
          ))}
        </div>

        {/* Step 1: Basic info */}
        {step === 1 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-300">Schritt 1: Grunddaten</h3>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Name *</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
                placeholder="z.B. Alfred AI Platform"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Beschreibung</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none h-20 resize-none"
                placeholder="Service-Beschreibung..."
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Kritikalitaet</label>
              <select
                value={criticality}
                onChange={e => setCriticality(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none"
              >
                {CRITICALITY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex justify-end">
              <button
                disabled={!name.trim()}
                onClick={() => setStep(2)}
                className="bg-blue-500/20 text-blue-400 px-4 py-2 rounded-lg text-sm hover:bg-blue-500/30 disabled:opacity-50"
              >Weiter</button>
            </div>
          </div>
        )}

        {/* Step 2: Components */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-300">Schritt 2: Komponenten</h3>
              <button onClick={addComponent} className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded hover:bg-green-500/30">+ Komponente</button>
            </div>
            {components.length === 0 && <p className="text-xs text-gray-500">Noch keine Komponenten hinzugefuegt.</p>}
            {components.map((comp, idx) => (
              <div key={idx} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Komponente {idx + 1}</span>
                  <button onClick={() => removeComponent(idx)} className="text-xs text-red-400 hover:text-red-300">Entfernen</button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={comp.name}
                    onChange={e => updateComponent(idx, { name: e.target.value })}
                    placeholder="Name"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                  <select
                    value={comp.role}
                    onChange={e => updateComponent(idx, { role: e.target.value })}
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  >
                    {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select
                    value={comp.assetId ?? ''}
                    onChange={e => updateComponent(idx, { assetId: e.target.value || undefined })}
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  >
                    <option value="">-- CMDB Asset --</option>
                    {cmdbAssets.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
                  </select>
                  <select
                    value={comp.failureImpact}
                    onChange={e => updateComponent(idx, { failureImpact: e.target.value })}
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  >
                    {IMPACT_OPTIONS.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <input
                    value={comp.ports ?? ''}
                    onChange={e => updateComponent(idx, { ports: e.target.value })}
                    placeholder="Ports (z.B. 80,443)"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                  <input
                    value={comp.dns ?? ''}
                    onChange={e => updateComponent(idx, { dns: e.target.value })}
                    placeholder="DNS"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={comp.required}
                    onChange={e => updateComponent(idx, { required: e.target.checked })}
                    className="rounded"
                  />
                  Required
                </label>
              </div>
            ))}
            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="text-sm text-gray-400 hover:text-gray-200">Zurueck</button>
              <button onClick={() => setStep(3)} className="bg-blue-500/20 text-blue-400 px-4 py-2 rounded-lg text-sm hover:bg-blue-500/30">Weiter</button>
            </div>
          </div>
        )}

        {/* Step 3: Failure Modes */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-300">Schritt 3: Failure Modes</h3>
              <button onClick={addFailureMode} className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded hover:bg-green-500/30">+ Failure Mode</button>
            </div>
            {failureModes.length === 0 && <p className="text-xs text-gray-500">Noch keine Failure Modes definiert.</p>}
            {failureModes.map((fm, idx) => (
              <div key={idx} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Failure Mode {idx + 1}</span>
                  <button onClick={() => removeFailureMode(idx)} className="text-xs text-red-400 hover:text-red-300">Entfernen</button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={fm.name}
                    onChange={e => updateFailureMode(idx, { name: e.target.value })}
                    placeholder="Name"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                  <input
                    value={fm.trigger}
                    onChange={e => updateFailureMode(idx, { trigger: e.target.value })}
                    placeholder="Trigger"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                  <select
                    value={fm.serviceImpact}
                    onChange={e => updateFailureMode(idx, { serviceImpact: e.target.value })}
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  >
                    {IMPACT_OPTIONS.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <input
                    value={fm.estimatedRecoveryMinutes ?? ''}
                    onChange={e => updateFailureMode(idx, { estimatedRecoveryMinutes: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                    placeholder="Recovery (Min.)"
                    type="number"
                    className="bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none"
                  />
                </div>
                {/* Affected components multi-select */}
                {components.length > 0 && (
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Betroffene Komponenten</label>
                    <div className="flex flex-wrap gap-1">
                      {components.filter(c => c.name).map(c => (
                        <button
                          key={c.name}
                          onClick={() => {
                            const current = fm.affectedComponents;
                            const next = current.includes(c.name)
                              ? current.filter(n => n !== c.name)
                              : [...current, c.name];
                            updateFailureMode(idx, { affectedComponents: next });
                          }}
                          className={clsx(
                            'text-[10px] px-2 py-0.5 rounded border',
                            fm.affectedComponents.includes(c.name)
                              ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                              : 'bg-[#111111] text-gray-500 border-[#1f1f1f] hover:text-gray-300',
                          )}
                        >{c.name}</button>
                      ))}
                    </div>
                  </div>
                )}
                <textarea
                  value={fm.cascadeEffects ?? ''}
                  onChange={e => updateFailureMode(idx, { cascadeEffects: e.target.value })}
                  placeholder="Kaskadeneffekte (kommagetrennt)"
                  className="w-full bg-[#111111] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-200 outline-none h-12 resize-none"
                />
              </div>
            ))}
            <div className="flex justify-between">
              <button onClick={() => setStep(2)} className="text-sm text-gray-400 hover:text-gray-200">Zurueck</button>
              <button onClick={() => setStep(4)} className="bg-blue-500/20 text-blue-400 px-4 py-2 rounded-lg text-sm hover:bg-blue-500/30">Weiter</button>
            </div>
          </div>
        )}

        {/* Step 4: Review */}
        {step === 4 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-300">Schritt 4: Zusammenfassung</h3>
            <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-4 space-y-3 text-xs">
              <InfoRow label="Name" value={name} />
              {description && <InfoRow label="Beschreibung" value={description} />}
              <InfoRow label="Kritikalitaet" value={criticality} />
              <InfoRow label="Komponenten" value={String(components.length)} />
              {components.map((c, i) => (
                <div key={i} className="pl-4 text-gray-400">
                  {c.name || '(unbenannt)'} - {c.role} {c.required ? '(required)' : ''}
                </div>
              ))}
              <InfoRow label="Failure Modes" value={String(failureModes.length)} />
              {failureModes.map((fm, i) => (
                <div key={i} className="pl-4 text-gray-400">
                  {fm.name || '(unbenannt)'} - Impact: {fm.serviceImpact}
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <button onClick={() => setStep(3)} className="text-sm text-gray-400 hover:text-gray-200">Zurueck</button>
              <button
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                className="bg-green-500/20 text-green-400 px-4 py-2 rounded-lg text-sm hover:bg-green-500/30 disabled:opacity-50"
              >{creating ? 'Erstellt...' : 'Service erstellen'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
