'use client';

import { useState, useEffect, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Incident {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: string;
  priority: string;
  affectedAssetIds: string[];
  affectedServiceIds: string[];
  symptoms: string;
  rootCause: string;
  resolution: string;
  workaround: string;
  postmortem: string;
  detectedBy: string;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  relatedIncidentId: string | null;
}

interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  riskLevel: string;
  affectedAssetIds: string[];
  implementationPlan: string;
  rollbackPlan: string;
  testPlan: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: string;
}

interface Service {
  id: string;
  name: string;
  description: string;
  category: string;
  environment: string;
  url: string;
  healthCheckUrl: string;
  healthStatus: 'healthy' | 'degraded' | 'down' | 'unknown';
  criticality: string;
  dependencies: string[];
  assetIds: string[];
  owner: string;
  documentation: string;
  slaNotes: string;
  maintenanceWindow: string;
  tags: string[];
}

type Tab = 'incidents' | 'changes' | 'services';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const SEV_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-blue-400',
};

const SEV_BG: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-400',
  high: 'bg-orange-500/10 text-orange-400',
  medium: 'bg-yellow-500/10 text-yellow-400',
  low: 'bg-blue-500/10 text-blue-400',
};

const SEV_ICONS: Record<string, string> = {
  critical: '\u26d4',
  high: '\u26a0\ufe0f',
  medium: '\u25cf',
  low: '\u2139\ufe0f',
};

const HEALTH_DOT: Record<string, string> = {
  healthy: 'bg-green-500',
  degraded: 'bg-yellow-500',
  down: 'bg-red-500',
  unknown: 'bg-gray-500',
};

const HEALTH_TEXT: Record<string, string> = {
  healthy: 'text-green-400',
  degraded: 'text-yellow-400',
  down: 'text-red-400',
  unknown: 'text-gray-400',
};

function fmtDate(d: string | null | undefined): string {
  if (!d) return '\u2014';
  return new Date(d).toLocaleString('de-AT', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    open: 'bg-red-500/10 text-red-400',
    acknowledged: 'bg-orange-500/10 text-orange-400',
    investigating: 'bg-yellow-500/10 text-yellow-400',
    resolved: 'bg-green-500/10 text-green-400',
    closed: 'bg-gray-500/10 text-gray-400',
    draft: 'bg-gray-500/10 text-gray-400',
    pending: 'bg-yellow-500/10 text-yellow-400',
    approved: 'bg-blue-500/10 text-blue-400',
    in_progress: 'bg-orange-500/10 text-orange-400',
    completed: 'bg-green-500/10 text-green-400',
    rolled_back: 'bg-red-500/10 text-red-400',
    cancelled: 'bg-gray-500/10 text-gray-400',
  };
  return map[status] ?? 'bg-gray-500/10 text-gray-400';
}

/* ------------------------------------------------------------------ */
/*  Create Modals (inline)                                            */
/* ------------------------------------------------------------------ */

function CreateIncidentModal({ onClose, onSave }: { onClose: () => void; onSave: (d: Partial<Incident>) => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<string>('medium');
  const [description, setDescription] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-200">Neuer Incident</h3>
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
        <select className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" value={severity} onChange={e => setSeverity(e.target.value)}>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <textarea className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 h-24" placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Abbrechen</button>
          <button onClick={() => { if (title) onSave({ title, severity: severity as Incident['severity'], description }); }} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Erstellen</button>
        </div>
      </div>
    </div>
  );
}

function CreateChangeModal({ onClose, onSave }: { onClose: () => void; onSave: (d: Partial<ChangeRequest>) => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('standard');
  const [riskLevel, setRiskLevel] = useState('medium');
  const [description, setDescription] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-200">Neuer Change Request</h3>
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
        <select className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" value={type} onChange={e => setType(e.target.value)}>
          <option value="standard">Standard</option>
          <option value="normal">Normal</option>
          <option value="emergency">Emergency</option>
        </select>
        <select className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" value={riskLevel} onChange={e => setRiskLevel(e.target.value)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <textarea className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 h-24" placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Abbrechen</button>
          <button onClick={() => { if (title) onSave({ title, type, riskLevel, description }); }} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Erstellen</button>
        </div>
      </div>
    </div>
  );
}

function CreateServiceModal({ onClose, onSave }: { onClose: () => void; onSave: (d: Partial<Service>) => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [criticality, setCriticality] = useState('medium');
  const [url, setUrl] = useState('');
  const [healthCheckUrl, setHealthCheckUrl] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-200">Neuer Service</h3>
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Kategorie" value={category} onChange={e => setCategory(e.target.value)} />
        <select className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" value={criticality} onChange={e => setCriticality(e.target.value)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="URL" value={url} onChange={e => setUrl(e.target.value)} />
        <input className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Health Check URL" value={healthCheckUrl} onChange={e => setHealthCheckUrl(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Abbrechen</button>
          <button onClick={() => { if (name) onSave({ name, category, criticality, url, healthCheckUrl }); }} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Erstellen</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export function ItsmPage() {
  const { client } = useConfig();
  const [tab, setTab] = useState<Tab>('incidents');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [changes, setChanges] = useState<ChangeRequest[]>([]);
  const [services, setServices] = useState<Service[]>([]);

  // Selection
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [selectedChange, setSelectedChange] = useState<ChangeRequest | null>(null);
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  // Filters
  const [incStatusFilter, setIncStatusFilter] = useState('');
  const [incSevFilter, setIncSevFilter] = useState('');
  const [chgStatusFilter, setChgStatusFilter] = useState('');
  const [chgTypeFilter, setChgTypeFilter] = useState('');

  // Create modals
  const [showCreateIncident, setShowCreateIncident] = useState(false);
  const [showCreateChange, setShowCreateChange] = useState(false);
  const [showCreateService, setShowCreateService] = useState(false);

  // Docs generation
  const [generatingRunbook, setGeneratingRunbook] = useState(false);
  const [generatingPostmortem, setGeneratingPostmortem] = useState(false);
  const [serviceDocs, setServiceDocs] = useState<{ id: string; docType: string; title: string; version: number; createdAt: string; linkedEntityType: string; linkedEntityId: string }[]>([]);

  /* ---- Data fetching ---- */

  const loadIncidents = useCallback(async () => {
    try {
      const filters: Record<string, string> = {};
      if (incStatusFilter) filters.status = incStatusFilter;
      if (incSevFilter) filters.severity = incSevFilter;
      const data = await client.itsmListIncidents(Object.keys(filters).length ? filters : undefined);
      setIncidents(Array.isArray(data) ? data : []);
    } catch (e) { setError((e as Error).message); }
  }, [client, incStatusFilter, incSevFilter]);

  const loadChanges = useCallback(async () => {
    try {
      const filters: Record<string, string> = {};
      if (chgStatusFilter) filters.status = chgStatusFilter;
      if (chgTypeFilter) filters.type = chgTypeFilter;
      const data = await client.itsmListChanges(Object.keys(filters).length ? filters : undefined);
      setChanges(Array.isArray(data) ? data : []);
    } catch (e) { setError((e as Error).message); }
  }, [client, chgStatusFilter, chgTypeFilter]);

  const loadServices = useCallback(async () => {
    try {
      const data = await client.itsmListServices();
      setServices(Array.isArray(data) ? data : []);
    } catch (e) { setError((e as Error).message); }
  }, [client]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([loadIncidents(), loadChanges(), loadServices()]);
    setLoading(false);
  }, [loadIncidents, loadChanges, loadServices]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Load document history when a service is selected
  useEffect(() => {
    if (selectedService) {
      loadServiceDocs(selectedService.id);
    } else {
      setServiceDocs([]);
    }
  }, [selectedService?.id]);

  /* ---- Actions ---- */

  async function updateIncidentStatus(id: string, status: string) {
    try {
      const updated = await client.itsmUpdateIncident(id, { status });
      setIncidents(prev => prev.map(i => i.id === id ? { ...i, ...updated } : i));
      if (selectedIncident?.id === id) setSelectedIncident({ ...selectedIncident, ...updated });
    } catch (e) { setError((e as Error).message); }
  }

  async function updateChangeStatus(id: string, status: string) {
    try {
      const updated = await client.itsmUpdateChange(id, { status });
      setChanges(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      if (selectedChange?.id === id) setSelectedChange({ ...selectedChange, ...updated });
    } catch (e) { setError((e as Error).message); }
  }

  async function createIncident(data: Partial<Incident>) {
    try {
      const created = await client.itsmCreateIncident(data);
      setIncidents(prev => [created, ...prev]);
      setShowCreateIncident(false);
    } catch (e) { setError((e as Error).message); }
  }

  async function createChange(data: Partial<ChangeRequest>) {
    try {
      const created = await client.itsmCreateChange(data);
      setChanges(prev => [created, ...prev]);
      setShowCreateChange(false);
    } catch (e) { setError((e as Error).message); }
  }

  async function createService(data: Partial<Service>) {
    try {
      const created = await client.itsmCreateService(data);
      setServices(prev => [created, ...prev]);
      setShowCreateService(false);
    } catch (e) { setError((e as Error).message); }
  }

  async function runHealthCheck() {
    try {
      await client.itsmHealthCheck();
      await loadServices();
    } catch (e) { setError((e as Error).message); }
  }

  async function generateRunbook(serviceId: string) {
    setGeneratingRunbook(true);
    try {
      await client.docsGenerate('runbook', { service_id: serviceId });
      await loadServices();
      // Refresh selected service from updated list
      const updated = (await client.itsmListServices()) as Service[];
      const svc = updated.find(s => s.id === serviceId);
      if (svc) setSelectedService(svc);
      // Load document history
      const docs = await client.cmdbListDocuments({ linked_entity_type: 'service', linked_entity_id: serviceId });
      setServiceDocs(Array.isArray(docs) ? docs : []);
    } catch (e) { setError((e as Error).message); }
    setGeneratingRunbook(false);
  }

  async function loadServiceDocs(serviceId: string) {
    try {
      const docs = await client.cmdbListDocuments({ linked_entity_type: 'service', linked_entity_id: serviceId });
      setServiceDocs(Array.isArray(docs) ? docs : []);
    } catch { setServiceDocs([]); }
  }

  async function generatePostmortem(incidentId: string) {
    setGeneratingPostmortem(true);
    try {
      await client.docsGenerate('incident_report', { incident_id: incidentId });
      // Refresh incident data
      const allInc = (await client.itsmListIncidents()) as Incident[];
      setIncidents(allInc);
      const updated = allInc.find(i => i.id === incidentId);
      if (updated) setSelectedIncident(updated);
    } catch (e) { setError((e as Error).message); }
    setGeneratingPostmortem(false);
  }

  /* ---- Filter helpers ---- */

  const filteredIncidents = incidents;
  const filteredChanges = changes;

  /* ---- Render ---- */

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'incidents', label: 'Incidents', count: incidents.length },
    { key: 'changes', label: 'Change Requests', count: changes.length },
    { key: 'services', label: 'Services', count: services.length },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold text-gray-200">ITSM</h1>
        <button onClick={loadAll} className="text-sm text-blue-400 hover:text-blue-300">Aktualisieren</button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 text-sm text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-3 text-red-300 hover:text-red-200">x</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#1f1f1f]">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSelectedIncident(null); setSelectedChange(null); setSelectedService(null); setGeneratingRunbook(false); setGeneratingPostmortem(false); setServiceDocs([]); }}
            className={clsx(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200',
            )}
          >
            {t.label} <span className="text-xs text-gray-500 ml-1">({t.count})</span>
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-400 text-sm py-4">Laden...</div>}

      {!loading && tab === 'incidents' && (
        <div className="flex gap-6">
          {/* List */}
          <div className={clsx('space-y-3', selectedIncident ? 'w-1/2' : 'w-full')}>
            {/* Filters + Create */}
            <div className="flex gap-2 items-center flex-wrap">
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={incStatusFilter} onChange={e => setIncStatusFilter(e.target.value)}>
                <option value="">Alle Status</option>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="investigating">Investigating</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={incSevFilter} onChange={e => setIncSevFilter(e.target.value)}>
                <option value="">Alle Severity</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <div className="flex-1" />
              <button onClick={() => setShowCreateIncident(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Incident
              </button>
            </div>

            {/* Table */}
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium w-8">Sev</th>
                    <th className="text-left px-4 py-2 font-medium">Titel</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Erstellt</th>
                    <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Assets</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIncidents.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Keine Incidents gefunden.</td></tr>
                  )}
                  {filteredIncidents.map(inc => (
                    <tr
                      key={inc.id}
                      onClick={() => setSelectedIncident(inc)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedIncident?.id === inc.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-4 py-2">
                        <span className={SEV_COLORS[inc.severity]} title={inc.severity}>{SEV_ICONS[inc.severity] ?? '\u25cf'}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-200">{inc.title}</td>
                      <td className="px-4 py-2">
                        <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(inc.status))}>{inc.status}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs hidden md:table-cell">{fmtDate(inc.openedAt)}</td>
                      <td className="px-4 py-2 text-gray-400 text-right hidden md:table-cell">{inc.affectedAssetIds?.length ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detail Panel */}
          {selectedIncident && (
            <div className="w-1/2 bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 space-y-4 overflow-y-auto max-h-[calc(100vh-220px)]">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-200">{selectedIncident.title}</h3>
                  <p className="text-xs text-gray-500 mt-1">ID: {selectedIncident.id}</p>
                </div>
                <button onClick={() => setSelectedIncident(null)} className="text-gray-500 hover:text-gray-300 text-lg">x</button>
              </div>

              <div className="flex gap-2 flex-wrap">
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', SEV_BG[selectedIncident.severity])}>{selectedIncident.severity}</span>
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(selectedIncident.status))}>{selectedIncident.status}</span>
                {selectedIncident.priority && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">P: {selectedIncident.priority}</span>}
              </div>

              {selectedIncident.description && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Beschreibung</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.description}</p>
                </div>
              )}

              {selectedIncident.symptoms && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Symptome</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.symptoms}</p>
                </div>
              )}

              {selectedIncident.rootCause && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Root Cause</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.rootCause}</p>
                </div>
              )}

              {selectedIncident.resolution && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Resolution</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.resolution}</p>
                </div>
              )}

              {selectedIncident.workaround && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Workaround</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.workaround}</p>
                </div>
              )}

              {/* Related Incident */}
              {selectedIncident.relatedIncidentId && (
                <div className="bg-[#1a1a1a] rounded p-2">
                  <p className="text-xs text-gray-500 mb-1">Verwandter Incident</p>
                  <p className="text-sm text-blue-400 font-mono">{selectedIncident.relatedIncidentId.slice(0, 8)}...</p>
                </div>
              )}

              {/* Postmortem */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Postmortem</p>
                {selectedIncident.postmortem ? (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedIncident.postmortem}</p>
                ) : (
                  <p className="text-xs text-gray-500 italic">Kein Postmortem vorhanden.</p>
                )}
                <button
                  onClick={() => generatePostmortem(selectedIncident.id)}
                  disabled={generatingPostmortem}
                  className="mt-2 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white rounded"
                >
                  {generatingPostmortem ? 'Generiere...' : 'Postmortem generieren'}
                </button>
              </div>

              {/* Affected Assets */}
              {selectedIncident.affectedAssetIds?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Betroffene Assets ({selectedIncident.affectedAssetIds.length})</p>
                  <div className="flex gap-1 flex-wrap">
                    {selectedIncident.affectedAssetIds.map(id => (
                      <span key={id} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-400 font-mono">{id}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Timeline</p>
                <div className="space-y-1 text-xs">
                  <div className="flex gap-3"><span className="text-gray-500 w-24">Erstellt:</span><span className="text-gray-300">{fmtDate(selectedIncident.openedAt)}</span></div>
                  {selectedIncident.acknowledgedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Acknowledged:</span><span className="text-gray-300">{fmtDate(selectedIncident.acknowledgedAt)}</span></div>}
                  {selectedIncident.resolvedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Resolved:</span><span className="text-gray-300">{fmtDate(selectedIncident.resolvedAt)}</span></div>}
                  {selectedIncident.closedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Closed:</span><span className="text-gray-300">{fmtDate(selectedIncident.closedAt)}</span></div>}
                  {selectedIncident.detectedBy && <div className="flex gap-3"><span className="text-gray-500 w-24">Erkannt von:</span><span className="text-gray-300">{selectedIncident.detectedBy}</span></div>}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 flex-wrap pt-2 border-t border-[#1f1f1f]">
                {selectedIncident.status === 'open' && (
                  <button onClick={() => updateIncidentStatus(selectedIncident.id, 'acknowledged')} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded">Acknowledge</button>
                )}
                {(selectedIncident.status === 'open' || selectedIncident.status === 'acknowledged') && (
                  <button onClick={() => updateIncidentStatus(selectedIncident.id, 'investigating')} className="px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded">Investigate</button>
                )}
                {selectedIncident.status !== 'resolved' && selectedIncident.status !== 'closed' && (
                  <button onClick={() => updateIncidentStatus(selectedIncident.id, 'resolved')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded">Resolve</button>
                )}
                {selectedIncident.status !== 'closed' && (
                  <button onClick={() => updateIncidentStatus(selectedIncident.id, 'closed')} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">Close</button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============= CHANGE REQUESTS TAB ============= */}
      {!loading && tab === 'changes' && (
        <div className="flex gap-6">
          <div className={clsx('space-y-3', selectedChange ? 'w-1/2' : 'w-full')}>
            <div className="flex gap-2 items-center flex-wrap">
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={chgStatusFilter} onChange={e => setChgStatusFilter(e.target.value)}>
                <option value="">Alle Status</option>
                <option value="draft">Draft</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="rolled_back">Rolled Back</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={chgTypeFilter} onChange={e => setChgTypeFilter(e.target.value)}>
                <option value="">Alle Typen</option>
                <option value="standard">Standard</option>
                <option value="normal">Normal</option>
                <option value="emergency">Emergency</option>
              </select>
              <div className="flex-1" />
              <button onClick={() => setShowCreateChange(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Change Request
              </button>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Titel</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Typ</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Risiko</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Geplant</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredChanges.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Keine Change Requests gefunden.</td></tr>
                  )}
                  {filteredChanges.map(chg => (
                    <tr
                      key={chg.id}
                      onClick={() => setSelectedChange(chg)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedChange?.id === chg.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-4 py-2">
                        <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(chg.status))}>{chg.status}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-200">{chg.title}</td>
                      <td className="px-4 py-2 text-gray-400 text-xs hidden md:table-cell capitalize">{chg.type}</td>
                      <td className="px-4 py-2 hidden md:table-cell">
                        <span className={clsx('text-xs', SEV_COLORS[chg.riskLevel] ?? 'text-gray-400')}>{chg.riskLevel}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs hidden md:table-cell">{fmtDate(chg.scheduledAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detail */}
          {selectedChange && (
            <div className="w-1/2 bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 space-y-4 overflow-y-auto max-h-[calc(100vh-220px)]">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-200">{selectedChange.title}</h3>
                  <p className="text-xs text-gray-500 mt-1">ID: {selectedChange.id}</p>
                </div>
                <button onClick={() => setSelectedChange(null)} className="text-gray-500 hover:text-gray-300 text-lg">x</button>
              </div>

              <div className="flex gap-2 flex-wrap">
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(selectedChange.status))}>{selectedChange.status}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400 capitalize">{selectedChange.type}</span>
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', SEV_BG[selectedChange.riskLevel] ?? 'bg-gray-500/10 text-gray-400')}>Risiko: {selectedChange.riskLevel}</span>
              </div>

              {selectedChange.description && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Beschreibung</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedChange.description}</p>
                </div>
              )}

              {selectedChange.implementationPlan && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Implementation Plan</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedChange.implementationPlan}</p>
                </div>
              )}

              {selectedChange.rollbackPlan && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Rollback Plan</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedChange.rollbackPlan}</p>
                </div>
              )}

              {selectedChange.testPlan && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Test Plan</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedChange.testPlan}</p>
                </div>
              )}

              {selectedChange.affectedAssetIds?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Betroffene Assets ({selectedChange.affectedAssetIds.length})</p>
                  <div className="flex gap-1 flex-wrap">
                    {selectedChange.affectedAssetIds.map(id => (
                      <span key={id} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-400 font-mono">{id}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Timeline</p>
                <div className="space-y-1 text-xs">
                  {selectedChange.scheduledAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Geplant:</span><span className="text-gray-300">{fmtDate(selectedChange.scheduledAt)}</span></div>}
                  {selectedChange.startedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Gestartet:</span><span className="text-gray-300">{fmtDate(selectedChange.startedAt)}</span></div>}
                  {selectedChange.completedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Abgeschlossen:</span><span className="text-gray-300">{fmtDate(selectedChange.completedAt)}</span></div>}
                  {selectedChange.result && <div className="flex gap-3"><span className="text-gray-500 w-24">Ergebnis:</span><span className="text-gray-300">{selectedChange.result}</span></div>}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 flex-wrap pt-2 border-t border-[#1f1f1f]">
                {(selectedChange.status === 'draft' || selectedChange.status === 'pending') && (
                  <button onClick={() => updateChangeStatus(selectedChange.id, 'approved')} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">Approve</button>
                )}
                {selectedChange.status === 'approved' && (
                  <button onClick={() => updateChangeStatus(selectedChange.id, 'in_progress')} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded">Start</button>
                )}
                {selectedChange.status === 'in_progress' && (
                  <button onClick={() => updateChangeStatus(selectedChange.id, 'completed')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded">Complete</button>
                )}
                {(selectedChange.status === 'in_progress' || selectedChange.status === 'completed') && (
                  <button onClick={() => updateChangeStatus(selectedChange.id, 'rolled_back')} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded">Rollback</button>
                )}
                {selectedChange.status !== 'completed' && selectedChange.status !== 'rolled_back' && selectedChange.status !== 'cancelled' && (
                  <button onClick={() => updateChangeStatus(selectedChange.id, 'cancelled')} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">Cancel</button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============= SERVICES TAB ============= */}
      {!loading && tab === 'services' && (
        <div className="flex gap-6">
          <div className={clsx('space-y-3', selectedService ? 'w-1/2' : 'w-full')}>
            <div className="flex gap-2 items-center">
              <button onClick={runHealthCheck} className="px-3 py-1.5 text-sm bg-green-700 hover:bg-green-600 text-white rounded">Health Check All</button>
              <div className="flex-1" />
              <button onClick={() => setShowCreateService(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Service
              </button>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium w-8">H</th>
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Kategorie</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Criticality</th>
                    <th className="text-left px-4 py-2 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {services.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Keine Services gefunden.</td></tr>
                  )}
                  {services.map(svc => (
                    <tr
                      key={svc.id}
                      onClick={() => setSelectedService(svc)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedService?.id === svc.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-4 py-2">
                        <span className={clsx('w-2.5 h-2.5 rounded-full inline-block', HEALTH_DOT[svc.healthStatus] ?? 'bg-gray-500')} />
                      </td>
                      <td className="px-4 py-2 text-gray-200">{svc.name}</td>
                      <td className="px-4 py-2 text-gray-400 text-xs hidden md:table-cell">{svc.category}</td>
                      <td className="px-4 py-2 hidden md:table-cell">
                        <span className={clsx('text-xs', SEV_COLORS[svc.criticality] ?? 'text-gray-400')}>{svc.criticality}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={clsx('text-xs', HEALTH_TEXT[svc.healthStatus] ?? 'text-gray-400')}>{svc.healthStatus}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detail */}
          {selectedService && (
            <div className="w-1/2 bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 space-y-4 overflow-y-auto max-h-[calc(100vh-220px)]">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-200">{selectedService.name}</h3>
                  <p className="text-xs text-gray-500 mt-1">ID: {selectedService.id}</p>
                </div>
                <button onClick={() => setSelectedService(null)} className="text-gray-500 hover:text-gray-300 text-lg">x</button>
              </div>

              <div className="flex gap-2 flex-wrap">
                <span className={clsx('flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full', {
                  'bg-green-500/10 text-green-400': selectedService.healthStatus === 'healthy',
                  'bg-yellow-500/10 text-yellow-400': selectedService.healthStatus === 'degraded',
                  'bg-red-500/10 text-red-400': selectedService.healthStatus === 'down',
                  'bg-gray-500/10 text-gray-400': selectedService.healthStatus === 'unknown',
                })}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', HEALTH_DOT[selectedService.healthStatus])} />
                  {selectedService.healthStatus}
                </span>
                {selectedService.category && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">{selectedService.category}</span>}
                {selectedService.criticality && <span className={clsx('text-xs px-2 py-0.5 rounded-full', SEV_BG[selectedService.criticality] ?? 'bg-gray-500/10 text-gray-400')}>{selectedService.criticality}</span>}
                {selectedService.environment && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">{selectedService.environment}</span>}
              </div>

              {selectedService.description && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Beschreibung</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedService.description}</p>
                </div>
              )}

              {selectedService.url && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">URL</p>
                  <a href={selectedService.url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-400 hover:text-blue-300 break-all">{selectedService.url}</a>
                </div>
              )}

              {selectedService.healthCheckUrl && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Health Check URL</p>
                  <span className="text-sm text-gray-300 font-mono break-all">{selectedService.healthCheckUrl}</span>
                </div>
              )}

              {selectedService.owner && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Owner</p>
                  <p className="text-sm text-gray-300">{selectedService.owner}</p>
                </div>
              )}

              {selectedService.dependencies?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Dependencies ({selectedService.dependencies.length})</p>
                  <div className="flex gap-1 flex-wrap">
                    {selectedService.dependencies.map(dep => (
                      <span key={dep} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-400">{dep}</span>
                    ))}
                  </div>
                </div>
              )}

              {selectedService.assetIds?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Asset IDs ({selectedService.assetIds.length})</p>
                  <div className="flex gap-1 flex-wrap">
                    {selectedService.assetIds.map(id => (
                      <span key={id} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-400 font-mono">{id}</span>
                    ))}
                  </div>
                </div>
              )}

              {selectedService.documentation && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Dokumentation</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedService.documentation}</p>
                </div>
              )}

              {/* Runbook Generation */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs text-gray-500">Runbook</p>
                  <button
                    onClick={() => generateRunbook(selectedService.id)}
                    disabled={generatingRunbook}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white rounded"
                  >
                    {generatingRunbook ? 'Generiere...' : 'Runbook generieren'}
                  </button>
                </div>
                {serviceDocs.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-500">Dokument-Historie</p>
                    {serviceDocs.map(doc => (
                      <div key={doc.id} className="flex items-center gap-2 text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5">
                        <span className="text-gray-400 font-mono">{doc.docType}</span>
                        <span className="text-gray-300 flex-1 truncate">{doc.title}</span>
                        <span className="text-gray-500">v{doc.version}</span>
                        <span className="text-gray-500">{fmtDate(doc.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {selectedService.slaNotes && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">SLA Notes</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedService.slaNotes}</p>
                </div>
              )}

              {selectedService.maintenanceWindow && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Wartungsfenster</p>
                  <p className="text-sm text-gray-300">{selectedService.maintenanceWindow}</p>
                </div>
              )}

              {selectedService.tags?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Tags</p>
                  <div className="flex gap-1 flex-wrap">
                    {selectedService.tags.map(tag => (
                      <span key={tag} className="text-xs bg-blue-500/10 text-blue-400 rounded px-2 py-0.5">{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Create Modals */}
      {showCreateIncident && <CreateIncidentModal onClose={() => setShowCreateIncident(false)} onSave={createIncident} />}
      {showCreateChange && <CreateChangeModal onClose={() => setShowCreateChange(false)} onSave={createChange} />}
      {showCreateService && <CreateServiceModal onClose={() => setShowCreateService(false)} onSave={createService} />}
    </div>
  );
}
