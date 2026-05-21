'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
  investigationNotes: string;
  rootCause: string;
  resolution: string;
  workaround: string;
  lessonsLearned: string;
  actionItems: string;
  postmortem: string;
  detectedBy: string;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  relatedIncidentId: string | null;
}

interface TransitionModalConfig {
  incidentId: string;
  targetStatus: string;
  label: string;
  fields: Array<{ key: string; label: string; required: boolean; placeholder: string }>;
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

interface ServiceComponent {
  assetId?: string;
  serviceId?: string;
  externalUrl?: string;
  role: string;
  name: string;
  required: boolean;
  healthStatus?: string;
  healthReason?: string;
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
  healthReason: string | null;
  criticality: string;
  dependencies: string[];
  assetIds: string[];
  owner: string;
  documentation: string;
  slaNotes: string;
  maintenanceWindow: string;
  tags: string[];
  components: ServiceComponent[];
}

interface Problem {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  category: string;
  rootCauseDescription: string;
  rootCauseCategory: string;
  workaround: string;
  proposedFix: string;
  isKnownError: boolean;
  knownErrorDescription: string;
  analysisNotes: string;
  linkedIncidentIds: string[];
  linkedChangeRequestId: string | null;
  affectedAssetIds: string[];
  affectedServiceIds: string[];
  detectedBy: string;
  detectedAt: string;
  analyzedAt: string | null;
  rootCauseIdentifiedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
}

type Tab = 'incidents' | 'changes' | 'services' | 'problems' | 'patterns';

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
    mitigating: 'bg-purple-500/10 text-purple-400',
    logged: 'bg-blue-500/10 text-blue-400',
    analyzing: 'bg-yellow-500/10 text-yellow-400',
    root_cause_identified: 'bg-purple-500/10 text-purple-400',
    fix_in_progress: 'bg-orange-500/10 text-orange-400',
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
/*  Editable Text Field                                                */
/* ------------------------------------------------------------------ */

function EditableTextField({ label, value, placeholder, onSave, disabled }: {
  label: string; value?: string; placeholder?: string; onSave: (val: string) => void; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? '');

  // Sync when value changes externally (e.g. incident selection change)
  useEffect(() => { setText(value ?? ''); setEditing(false); }, [value]);

  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[80px]"
            placeholder={placeholder}
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <button onClick={() => { onSave(text); setEditing(false); }} className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">Speichern</button>
            <button onClick={() => { setText(value ?? ''); setEditing(false); }} className="px-3 py-1 text-xs text-gray-400 hover:text-white">Abbrechen</button>
          </div>
        </div>
      ) : (
        <div>
          {value ? (
            <p className="text-sm text-gray-300 whitespace-pre-wrap">{value}</p>
          ) : (
            <p className="text-xs text-gray-500 italic">Nicht dokumentiert.</p>
          )}
          {!disabled && (
            <button onClick={() => { setText(value ?? ''); setEditing(true); }} className="mt-1 text-xs text-blue-400 hover:text-blue-300">
              {value ? 'Bearbeiten' : '+ Hinzufügen'}
            </button>
          )}
        </div>
      )}
    </div>
  );
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
  const [allAssets, setAllAssets] = useState<Array<{ id: string; name: string; assetType: string }>>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [selectedProblem, setSelectedProblem] = useState<Problem | null>(null);
  const [showCreateProblem, setShowCreateProblem] = useState(false);
  const [probStatusFilter, setProbStatusFilter] = useState('');
  const [probPriorityFilter, setProbPriorityFilter] = useState('');
  const [addingAnalysisNote, setAddingAnalysisNote] = useState(false);
  const [analysisNoteText, setAnalysisNoteText] = useState('');

  // v632 — Multi-Select & Patterns
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<Set<string>>(new Set());
  const [bulkMergeMode, setBulkMergeMode] = useState<'new-problem' | 'existing-problem' | null>(null);
  const [bulkMergeProblemId, setBulkMergeProblemId] = useState<string>('');
  const [bulkMergeTitle, setBulkMergeTitle] = useState('');
  const [bulkMergePriority, setBulkMergePriority] = useState('medium');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);

  const [patterns, setPatterns] = useState<Array<{
    patternKey: string; incidentIds: string[]; assetIds: string[]; serviceIds: string[];
    keywordCluster: string[]; incidentCount: number; firstSeen: string; lastSeen: string;
    existingProblemId?: string;
  }>>([]);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [patternWindowDays, setPatternWindowDays] = useState(14);
  const [patternMinIncidents, setPatternMinIncidents] = useState(2);

  // Selection
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [selectedChange, setSelectedChange] = useState<ChangeRequest | null>(null);
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  // Filters
  // v645 — default 'active' = open/acknowledged/investigating/mitigating (closed/resolved werden ausgeblendet)
  const [incStatusFilter, setIncStatusFilter] = useState('active');
  const [incSevFilter, setIncSevFilter] = useState('');
  const [chgStatusFilter, setChgStatusFilter] = useState('active');
  const [chgTypeFilter, setChgTypeFilter] = useState('');
  const [prbStatusFilter2, setPrbStatusFilter2] = useState('active');
  // v645 — Multi-Select states für Bulk-Actions
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<string>>(new Set());
  const [selectedProblemIds2, setSelectedProblemIds2] = useState<Set<string>>(new Set());
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [bulkBusy2, setBulkBusy2] = useState(false);
  const [bulkModal, setBulkModal] = useState<null | { kind: 'inc-close' | 'inc-sev' | 'prb-status'; ids: string[] }>(null);
  const [bulkParams, setBulkParams] = useState<Record<string, string>>({});

  // Create modals
  const [showCreateIncident, setShowCreateIncident] = useState(false);
  const [showCreateChange, setShowCreateChange] = useState(false);
  const [showCreateService, setShowCreateService] = useState(false);

  // Status transition modal
  const [transitionModal, setTransitionModal] = useState<TransitionModalConfig | null>(null);
  const [transitionFields, setTransitionFields] = useState<Record<string, string>>({});

  // Inline note adding
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');

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

  const loadAssets = useCallback(async () => {
    try {
      const data = await client.cmdbListAssets();
      setAllAssets(Array.isArray(data) ? data : []);
    } catch { /* non-critical */ }
  }, [client]);

  const loadProblems = useCallback(async () => {
    try {
      const filters: Record<string, string> = {};
      if (probStatusFilter) filters.status = probStatusFilter;
      if (probPriorityFilter) filters.priority = probPriorityFilter;
      const data = await client.itsmListProblems(Object.keys(filters).length ? filters : undefined);
      setProblems(Array.isArray(data) ? data : []);
    } catch (e) { setError((e as Error).message); }
  }, [client, probStatusFilter, probPriorityFilter]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([loadIncidents(), loadChanges(), loadServices(), loadAssets(), loadProblems()]);
    setLoading(false);
  }, [loadIncidents, loadChanges, loadServices, loadAssets, loadProblems]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // v632 — Pattern-Loader
  const loadPatterns = useCallback(async () => {
    if (!client) return;
    setPatternsLoading(true);
    try {
      const list = await client.itsmDetectPatterns(patternWindowDays, patternMinIncidents);
      setPatterns(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPatternsLoading(false); }
  }, [client, patternWindowDays, patternMinIncidents]);

  // Load patterns when entering the tab or filters change
  useEffect(() => { if (tab === 'patterns') loadPatterns(); }, [tab, loadPatterns]);

  function toggleIncSelect(id: string) {
    setSelectedIncidentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearIncSelection() { setSelectedIncidentIds(new Set()); }

  async function executeBulkMerge() {
    if (!client) return;
    const ids = [...selectedIncidentIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      if (bulkMergeMode === 'new-problem') {
        if (!bulkMergeTitle.trim()) { setError('Titel für neues Problem fehlt.'); return; }
        await client.itsmPromoteIncidents(bulkMergeTitle.trim(), ids, bulkMergePriority);
      } else if (bulkMergeMode === 'existing-problem') {
        if (!bulkMergeProblemId) { setError('Bitte Problem auswählen.'); return; }
        await client.itsmBulkLinkToProblem(bulkMergeProblemId, ids);
      }
      setBulkMergeMode(null);
      setBulkMergeTitle('');
      setBulkMergeProblemId('');
      clearIncSelection();
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  }

  async function runBackfill() {
    if (!client) return;
    if (!confirm('Backfill scannt alle Incidents ohne Asset-Zuordnung und versucht Asset-Namen im Titel zu finden. Fortfahren?')) return;
    setBackfillBusy(true);
    try {
      const r = await client.itsmBackfillAssets();
      alert(`Backfill abgeschlossen: ${r.updated} aktualisiert, ${r.skipped} bereits gesetzt, ${r.unmatched} kein Match (gesamt ${r.total}).`);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBackfillBusy(false); }
  }

  async function promoteFromPattern(p: typeof patterns[number]) {
    if (!client) return;
    const title = `Wiederkehrend: ${p.keywordCluster.slice(0, 4).join(', ') || 'unbenannt'} (${p.incidentCount}×)`;
    if (!confirm(`Problem-Ticket "${title}" mit ${p.incidentCount} verlinkten Incidents erstellen?`)) return;
    setBulkBusy(true);
    try {
      await client.itsmPromoteIncidents(title, p.incidentIds, p.incidentCount >= 5 ? 'high' : 'medium');
      await Promise.all([loadAll(), loadPatterns()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  }

  // Reset note state when switching incidents
  useEffect(() => { setAddingNote(false); setNoteText(''); }, [selectedIncident?.id]);

  // Load document history when a service is selected
  useEffect(() => {
    if (selectedService) {
      loadServiceDocs(selectedService.id);
    } else {
      setServiceDocs([]);
    }
  }, [selectedService?.id]);

  /* ---- Actions ---- */

  const TRANSITION_FIELDS: Record<string, Array<{ key: string; label: string; required: boolean; placeholder: string }>> = {
    acknowledged: [],
    investigating: [{ key: 'investigation_notes', label: 'Untersuchungsnotizen', required: true, placeholder: 'Was wird untersucht? Erste Beobachtungen...' }],
    mitigating: [{ key: 'workaround', label: 'Workaround', required: true, placeholder: 'Welcher Workaround wird angewendet?' }],
    resolved: [
      { key: 'root_cause', label: 'Root Cause', required: true, placeholder: 'Was war die Ursache?' },
      { key: 'resolution', label: 'Resolution', required: true, placeholder: 'Wie wurde es gelöst?' },
    ],
    closed: [
      { key: 'lessons_learned', label: 'Lessons Learned', required: false, placeholder: 'Was wurde gelernt? (optional)' },
      { key: 'action_items', label: 'Action Items', required: false, placeholder: '- [ ] Monitoring verbessern\n- [ ] Runbook aktualisieren (optional)' },
    ],
  };

  function openTransitionModal(incidentId: string, targetStatus: string) {
    const fields = TRANSITION_FIELDS[targetStatus] ?? [];
    if (fields.length === 0) {
      // No fields required — submit immediately without modal
      submitTransition(incidentId, targetStatus, {});
      return;
    }
    const labels: Record<string, string> = { acknowledged: 'Acknowledge', investigating: 'Investigate', mitigating: 'Mitigate', resolved: 'Resolve', closed: 'Close' };
    setTransitionFields({});
    setTransitionModal({ incidentId, targetStatus, label: labels[targetStatus] ?? targetStatus, fields });
  }

  async function updateIncidentField(id: string, fields: Record<string, unknown>) {
    try {
      const updated = await client.itsmUpdateIncident(id, fields);
      setIncidents(prev => prev.map(i => i.id === id ? { ...i, ...updated } : i));
      if (selectedIncident?.id === id) setSelectedIncident({ ...selectedIncident, ...updated });
    } catch (e) { setError((e as Error).message); }
  }

  async function submitTransition(id: string, status: string, fields: Record<string, string>) {
    try {
      const updated = await client.itsmUpdateIncident(id, { status, ...fields });
      setIncidents(prev => prev.map(i => i.id === id ? { ...i, ...updated } : i));
      if (selectedIncident?.id === id) setSelectedIncident({ ...selectedIncident, ...updated });
      setTransitionModal(null);
      setTransitionFields({});
    } catch (e) { setError((e as Error).message); }
  }

  // Change transition modal state
  const [changeTransitionModal, setChangeTransitionModal] = useState<TransitionModalConfig | null>(null);
  const [changeTransitionFields, setChangeTransitionFields] = useState<Record<string, string>>({});

  const CHANGE_TRANSITION_FIELDS: Record<string, Array<{ key: string; label: string; required: boolean; placeholder: string }>> = {
    approved: [],
    in_progress: [],
    completed: [{ key: 'result', label: 'Ergebnis', required: true, placeholder: 'Was wurde umgesetzt? Ergebnis der Änderung...' }],
    rolled_back: [{ key: 'result', label: 'Rollback-Grund', required: true, placeholder: 'Warum wurde zurückgerollt?' }],
    cancelled: [],
  };

  function openChangeTransition(changeId: string, targetStatus: string) {
    const fields = CHANGE_TRANSITION_FIELDS[targetStatus] ?? [];
    if (fields.length === 0) {
      submitChangeTransition(changeId, targetStatus, {});
      return;
    }
    const labels: Record<string, string> = { approved: 'Approve', in_progress: 'Start', completed: 'Complete', rolled_back: 'Rollback', cancelled: 'Cancel' };
    setChangeTransitionFields({});
    setChangeTransitionModal({ incidentId: changeId, targetStatus, label: labels[targetStatus] ?? targetStatus, fields });
  }

  async function submitChangeTransition(id: string, status: string, fields: Record<string, string>) {
    try {
      const updated = await client.itsmUpdateChange(id, { status, ...fields });
      setChanges(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      if (selectedChange?.id === id) setSelectedChange({ ...selectedChange, ...updated });
      setChangeTransitionModal(null);
      setChangeTransitionFields({});
    } catch (e) { setError((e as Error).message); }
  }

  async function updateChangeField(id: string, fields: Record<string, unknown>) {
    try {
      const updated = await client.itsmUpdateChange(id, fields);
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

  // Problem Management Actions
  async function createProblem(data: Partial<Problem>) {
    try {
      const created = await client.itsmCreateProblem(data);
      setProblems(prev => [created, ...prev]);
      setShowCreateProblem(false);
    } catch (e) { setError((e as Error).message); }
  }

  async function updateProblemField(id: string, fields: Record<string, unknown>) {
    try {
      const updated = await client.itsmUpdateProblem(id, fields);
      setProblems(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p));
      if (selectedProblem?.id === id) setSelectedProblem({ ...selectedProblem, ...updated });
    } catch (e) { setError((e as Error).message); }
  }

  // Problem status transitions
  const PROBLEM_TRANSITION_FIELDS: Record<string, Array<{ key: string; label: string; required: boolean; placeholder: string }>> = {
    analyzing: [],
    root_cause_identified: [
      { key: 'root_cause_description', label: 'Root Cause', required: true, placeholder: 'Was ist die Ursache?' },
      { key: 'root_cause_category', label: 'Kategorie', required: false, placeholder: 'infrastructure/software/...' },
    ],
    fix_in_progress: [],
    resolved: [{ key: 'proposed_fix', label: 'Angewandter Fix', required: true, placeholder: 'Wie wurde es dauerhaft gelöst?' }],
    closed: [],
  };

  const [problemTransitionModal, setProblemTransitionModal] = useState<TransitionModalConfig | null>(null);
  const [problemTransitionFields, setProblemTransitionFields] = useState<Record<string, string>>({});

  function openProblemTransition(problemId: string, targetStatus: string) {
    const fields = PROBLEM_TRANSITION_FIELDS[targetStatus] ?? [];
    if (fields.length === 0) { submitProblemTransition(problemId, targetStatus, {}); return; }
    const labels: Record<string, string> = { analyzing: 'Analyze', root_cause_identified: 'Root Cause', fix_in_progress: 'Fix starten', resolved: 'Resolve', closed: 'Close' };
    setProblemTransitionFields({});
    setProblemTransitionModal({ incidentId: problemId, targetStatus, label: labels[targetStatus] ?? targetStatus, fields });
  }

  async function submitProblemTransition(id: string, status: string, fields: Record<string, string>) {
    try {
      const updated = await client.itsmUpdateProblem(id, { status, ...fields });
      setProblems(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p));
      if (selectedProblem?.id === id) setSelectedProblem({ ...selectedProblem, ...updated });
      setProblemTransitionModal(null);
      setProblemTransitionFields({});
    } catch (e) { setError((e as Error).message); }
  }

  async function generateRunbook(serviceId: string) {
    setGeneratingRunbook(true);
    try {
      await client.docsGenerate('runbook', { service_id: serviceId });
      // Refresh services list (single fetch, not double)
      const updated = (await client.itsmListServices()) as Service[];
      setServices(Array.isArray(updated) ? updated : []);
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

  // v645 — Bulk-Action handlers
  async function bulkIncAcknowledge() {
    if (selectedIncidentIds.size === 0) return;
    if (!confirm(`${selectedIncidentIds.size} Incidents als acknowledged markieren?`)) return;
    setBulkBusy2(true);
    try {
      const r = await client.itsmBulkIncidents([...selectedIncidentIds], 'acknowledge');
      alert(`${r.ok}/${selectedIncidentIds.size} acknowledged${r.failed.length > 0 ? ` (${r.failed.length} failed)` : ''}`);
      setSelectedIncidentIds(new Set());
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy2(false); }
  }
  function startBulkClose() {
    if (selectedIncidentIds.size === 0) return;
    setBulkParams({ resolution: '' });
    setBulkModal({ kind: 'inc-close', ids: [...selectedIncidentIds] });
  }
  function startBulkSeverity() {
    if (selectedIncidentIds.size === 0) return;
    setBulkParams({ severity: 'high' });
    setBulkModal({ kind: 'inc-sev', ids: [...selectedIncidentIds] });
  }
  async function executeBulkInc() {
    if (!bulkModal) return;
    setBulkBusy2(true);
    try {
      let r: { ok: number; failed: string[] };
      if (bulkModal.kind === 'inc-close') {
        if (!bulkParams.resolution?.trim()) { setError('Resolution-Text fehlt.'); setBulkBusy2(false); return; }
        r = await client.itsmBulkIncidents(bulkModal.ids, 'close', { resolution: bulkParams.resolution });
      } else if (bulkModal.kind === 'inc-sev') {
        r = await client.itsmBulkIncidents(bulkModal.ids, 'change_severity', { severity: bulkParams.severity });
      } else if (bulkModal.kind === 'prb-status') {
        r = await client.itsmBulkProblems(bulkModal.ids, 'change_status', { status: bulkParams.status });
      } else { return; }
      alert(`${r.ok}/${bulkModal.ids.length} ok${r.failed.length > 0 ? ` (${r.failed.length} failed)` : ''}`);
      setBulkModal(null);
      setSelectedIncidentIds(new Set());
      setSelectedProblemIds2(new Set());
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy2(false); }
  }

  async function bulkChangeAction(action: 'approve' | 'reject') {
    if (selectedChangeIds.size === 0) return;
    if (!confirm(`${selectedChangeIds.size} Changes ${action === 'approve' ? 'genehmigen' : 'ablehnen'}?`)) return;
    setBulkBusy2(true);
    try {
      const r = await client.itsmBulkChanges([...selectedChangeIds], action);
      alert(`${r.ok}/${selectedChangeIds.size} ${action}d`);
      setSelectedChangeIds(new Set());
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy2(false); }
  }

  function startBulkProblemStatus() {
    if (selectedProblemIds2.size === 0) return;
    setBulkParams({ status: 'analyzing' });
    setBulkModal({ kind: 'prb-status', ids: [...selectedProblemIds2] });
  }
  async function bulkProblemMarkKnownError() {
    if (selectedProblemIds2.size === 0) return;
    const desc = prompt('Known-Error-Beschreibung (gilt für alle ausgewählten):');
    if (!desc) return;
    setBulkBusy2(true);
    try {
      const r = await client.itsmBulkProblems([...selectedProblemIds2], 'mark_known_error', { description: desc });
      alert(`${r.ok}/${selectedProblemIds2.size} als Known-Error markiert`);
      setSelectedProblemIds2(new Set());
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy2(false); }
  }

  async function bulkServiceHealthCheck() {
    if (selectedServiceIds.size === 0) return;
    setBulkBusy2(true);
    try {
      const r = await client.itsmBulkServices([...selectedServiceIds], 'health_check');
      alert(`${r.ok}/${selectedServiceIds.size} Health-Checks ausgeführt`);
      setSelectedServiceIds(new Set());
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy2(false); }
  }

  function toggleChgSel(id: string) {
    setSelectedChangeIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function togglePrbSel(id: string) {
    setSelectedProblemIds2(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleSvcSel(id: string) {
    setSelectedServiceIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  /* ---- Filter helpers ---- */

  // v645 — Active = nicht-finale Stati
  const INCIDENT_ACTIVE_STATES = new Set(['open', 'acknowledged', 'investigating', 'mitigating']);
  const CHANGE_ACTIVE_STATES = new Set(['pending', 'approved', 'in_progress']);
  const PROBLEM_ACTIVE_STATES = new Set(['open', 'analyzing', 'root_cause_identified', 'fix_in_progress']);

  function applyIncFilter(inc: Incident): boolean {
    if (incStatusFilter === 'active') return INCIDENT_ACTIVE_STATES.has(inc.status);
    if (incStatusFilter && inc.status !== incStatusFilter) return false;
    if (incSevFilter && inc.severity !== incSevFilter) return false;
    return true;
  }
  function applyChgFilter(chg: ChangeRequest): boolean {
    if (chgStatusFilter === 'active') return CHANGE_ACTIVE_STATES.has(chg.status);
    if (chgStatusFilter && chg.status !== chgStatusFilter) return false;
    if (chgTypeFilter && chg.type !== chgTypeFilter) return false;
    return true;
  }
  function applyPrbFilter(p: Problem): boolean {
    if (prbStatusFilter2 === 'active') return PROBLEM_ACTIVE_STATES.has(p.status);
    if (prbStatusFilter2 && p.status !== prbStatusFilter2) return false;
    return true;
  }

  const filteredIncidents = incidents.filter(applyIncFilter);
  const filteredChanges = changes.filter(applyChgFilter);
  const filteredProblems2 = problems.filter(applyPrbFilter);

  // v645 — Stats für Header
  const incStats = useMemo(() => {
    const stats = { open: 0, acknowledged: 0, investigating: 0, resolved: 0, closed: 0, critical: 0, high: 0 };
    for (const i of incidents) {
      if (i.status === 'open') stats.open++;
      else if (i.status === 'acknowledged') stats.acknowledged++;
      else if (i.status === 'investigating' || i.status === 'mitigating') stats.investigating++;
      else if (i.status === 'resolved') stats.resolved++;
      else if (i.status === 'closed') stats.closed++;
      if (i.severity === 'critical') stats.critical++;
      else if (i.severity === 'high') stats.high++;
    }
    return stats;
  }, [incidents]);
  const chgStats = useMemo(() => {
    const s = { pending: 0, approved: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const c of changes) { if (c.status in s) (s as any)[c.status]++; }
    return s;
  }, [changes]);
  const svcStats = useMemo(() => {
    const s = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
    for (const v of services) { if (v.healthStatus in s) (s as any)[v.healthStatus]++; }
    return s;
  }, [services]);
  const prbStats = useMemo(() => {
    const s = { open: 0, analyzing: 0, root_cause_identified: 0, resolved: 0, closed: 0 };
    for (const p of problems) { if (p.status in s) (s as any)[p.status]++; }
    return s;
  }, [problems]);

  /* ---- Render ---- */

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'incidents', label: 'Incidents', count: incidents.length },
    { key: 'changes', label: 'Change Requests', count: changes.length },
    { key: 'services', label: 'Services', count: services.length },
    { key: 'problems', label: 'Problems', count: problems.length },
    { key: 'patterns', label: '🔁 Patterns', count: patterns.length },
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
            onClick={() => { setTab(t.key); setSelectedIncident(null); setSelectedChange(null); setSelectedService(null); setSelectedProblem(null); setGeneratingRunbook(false); setGeneratingPostmortem(false); setServiceDocs([]); }}
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
            {/* v645 — Stats-Bar */}
            <div className="flex gap-2 flex-wrap text-xs">
              <StatChip active={incStatusFilter === 'active'} onClick={() => setIncStatusFilter('active')} label="Aktiv" value={incStats.open + incStats.acknowledged + incStats.investigating} tone="blue" />
              <StatChip active={incStatusFilter === 'open'} onClick={() => setIncStatusFilter('open')} label="Open" value={incStats.open} tone="red" />
              <StatChip active={incStatusFilter === 'acknowledged'} onClick={() => setIncStatusFilter('acknowledged')} label="Ack" value={incStats.acknowledged} tone="amber" />
              <StatChip active={incStatusFilter === 'investigating'} onClick={() => setIncStatusFilter('investigating')} label="Inv" value={incStats.investigating} tone="amber" />
              <StatChip active={incStatusFilter === 'resolved'} onClick={() => setIncStatusFilter('resolved')} label="Resolved" value={incStats.resolved} tone="emerald" />
              <StatChip active={incStatusFilter === 'closed'} onClick={() => setIncStatusFilter('closed')} label="Closed" value={incStats.closed} tone="gray" />
              <div className="flex-1" />
              <StatChip active={incSevFilter === 'critical'} onClick={() => setIncSevFilter(incSevFilter === 'critical' ? '' : 'critical')} label="🔴 Crit" value={incStats.critical} tone="red" />
              <StatChip active={incSevFilter === 'high'} onClick={() => setIncSevFilter(incSevFilter === 'high' ? '' : 'high')} label="🟠 High" value={incStats.high} tone="amber" />
            </div>
            {/* Filters + Create */}
            <div className="flex gap-2 items-center flex-wrap">
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={incStatusFilter} onChange={e => setIncStatusFilter(e.target.value)}>
                <option value="active">⚡ Alle aktiv (default)</option>
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
              <button
                onClick={runBackfill}
                disabled={backfillBusy}
                className="px-3 py-1.5 text-sm bg-amber-600/20 border border-amber-500/40 text-amber-300 hover:bg-amber-600/30 rounded disabled:opacity-50"
                title="Asset-IDs in alle Incidents nachtragen \u2014 verbessert Pattern-Detection auf Altdaten"
              >{backfillBusy ? 'Backfill \u2026' : '\ud83d\udd27 Asset-Backfill'}</button>
              <button onClick={() => setShowCreateIncident(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Incident
              </button>
            </div>

            {/* v632/v645 \u2014 Bulk-Toolbar */}
            {selectedIncidentIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-200">
                  <strong>{selectedIncidentIds.size}</strong> Incident(s) ausgew\u00e4hlt
                </span>
                <div className="flex-1" />
                <button onClick={clearIncSelection} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Auswahl l\u00f6schen</button>
                <button onClick={bulkIncAcknowledge} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-amber-600/30 border border-amber-500/40 text-amber-200 rounded hover:bg-amber-600/50 disabled:opacity-50">\u2713 Acknowledge</button>
                <button onClick={startBulkSeverity} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-orange-600/30 border border-orange-500/40 text-orange-200 rounded hover:bg-orange-600/50 disabled:opacity-50">\u26a0 Severity</button>
                <button onClick={startBulkClose} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-zinc-600/30 border border-zinc-500/40 text-zinc-200 rounded hover:bg-zinc-600/50 disabled:opacity-50">\u2715 Close</button>
                <span className="text-gray-700 mx-1">\u00b7</span>
                <button onClick={() => { setBulkMergeMode('new-problem'); setBulkMergeTitle(`Wiederkehrender Vorfall (${selectedIncidentIds.size}\u00d7)`); }} className="px-2 py-1 text-xs bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 rounded hover:bg-emerald-600/50">+ Neues Problem</button>
                <button onClick={() => setBulkMergeMode('existing-problem')} className="px-2 py-1 text-xs bg-blue-600/30 border border-blue-500/40 text-blue-200 rounded hover:bg-blue-600/50">\u2192 Bestehendes Problem</button>
              </div>
            )}

            {/* Table */}
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={filteredIncidents.length > 0 && filteredIncidents.every(i => selectedIncidentIds.has(i.id))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIncidentIds(new Set(filteredIncidents.map(i => i.id)));
                          else clearIncSelection();
                        }}
                        title="Alle ausw\u00e4hlen"
                      />
                    </th>
                    <th className="text-left px-4 py-2 font-medium w-8">Sev</th>
                    <th className="text-left px-4 py-2 font-medium">Titel</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Erstellt</th>
                    <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Assets</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIncidents.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Keine Incidents gefunden.</td></tr>
                  )}
                  {filteredIncidents.map(inc => (
                    <tr
                      key={inc.id}
                      onClick={() => setSelectedIncident(inc)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedIncidentIds.has(inc.id) ? 'bg-blue-500/10' :
                        selectedIncident?.id === inc.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-2 py-2" onClick={(e) => { e.stopPropagation(); toggleIncSelect(inc.id); }}>
                        <input
                          type="checkbox"
                          checked={selectedIncidentIds.has(inc.id)}
                          onChange={() => toggleIncSelect(inc.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
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

              <div className="flex gap-2 flex-wrap items-center">
                {selectedIncident.status !== 'closed' ? (
                  <select
                    className={clsx('text-xs px-2 py-0.5 rounded-full border-0 cursor-pointer', SEV_BG[selectedIncident.severity])}
                    value={selectedIncident.severity}
                    onChange={e => updateIncidentField(selectedIncident.id, { severity: e.target.value })}
                  >
                    <option value="critical">critical</option>
                    <option value="high">high</option>
                    <option value="medium">medium</option>
                    <option value="low">low</option>
                  </select>
                ) : (
                  <span className={clsx('text-xs px-2 py-0.5 rounded-full', SEV_BG[selectedIncident.severity])}>{selectedIncident.severity}</span>
                )}
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(selectedIncident.status))}>{selectedIncident.status}</span>
                {selectedIncident.status !== 'closed' ? (
                  <select
                    className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400 border-0 cursor-pointer"
                    value={selectedIncident.priority ?? '3'}
                    onChange={e => updateIncidentField(selectedIncident.id, { priority: e.target.value })}
                  >
                    <option value="1">P1</option>
                    <option value="2">P2</option>
                    <option value="3">P3</option>
                    <option value="4">P4</option>
                    <option value="5">P5</option>
                  </select>
                ) : (
                  selectedIncident.priority && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">P: {selectedIncident.priority}</span>
                )}
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

              {/* Investigation Notes — always visible with "Add Note" */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Untersuchungsnotizen</p>
                {selectedIncident.investigationNotes ? (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap mb-2">{selectedIncident.investigationNotes}</p>
                ) : (
                  <p className="text-xs text-gray-500 italic mb-2">Keine Notizen vorhanden.</p>
                )}
                {selectedIncident.status !== 'closed' && selectedIncident.status !== 'resolved' && (
                  addingNote ? (
                    <div className="space-y-2">
                      <textarea
                        className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[60px]"
                        placeholder="Beobachtung, Analyse, Maßnahme..."
                        value={noteText}
                        onChange={e => setNoteText(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            if (!noteText.trim()) return;
                            await updateIncidentField(selectedIncident.id, { investigation_notes: noteText.trim() });
                            setNoteText('');
                            setAddingNote(false);
                          }}
                          className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
                        >Speichern</button>
                        <button onClick={() => { setAddingNote(false); setNoteText(''); }} className="px-3 py-1 text-xs text-gray-400 hover:text-white">Abbrechen</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setAddingNote(true)} className="text-xs text-blue-400 hover:text-blue-300">+ Notiz hinzufügen</button>
                  )
                )}
              </div>

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

              {/* Lessons Learned — editable */}
              <EditableTextField
                label="Lessons Learned"
                value={selectedIncident.lessonsLearned}
                placeholder="Was wurde gelernt? Was würde man anders machen?"
                onSave={val => updateIncidentField(selectedIncident.id, { lessons_learned: val })}
                disabled={selectedIncident.status === 'closed'}
              />

              {/* Action Items — editable */}
              <EditableTextField
                label="Action Items"
                value={selectedIncident.actionItems}
                placeholder="- [ ] Monitoring verbessern&#10;- [ ] Runbook aktualisieren&#10;- [ ] ..."
                onSave={val => updateIncidentField(selectedIncident.id, { action_items: val })}
                disabled={selectedIncident.status === 'closed'}
              />

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

              {/* Affected Assets — with name resolution + add/remove */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Betroffene Assets ({selectedIncident.affectedAssetIds?.length ?? 0})</p>
                <div className="flex gap-1 flex-wrap mb-2">
                  {(selectedIncident.affectedAssetIds ?? []).map(aid => {
                    const asset = allAssets.find(a => a.id === aid);
                    return (
                      <span key={aid} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-300 font-mono flex items-center gap-1">
                        {asset ? `${asset.name} (${asset.assetType})` : aid.slice(0, 8)}
                        {selectedIncident.status !== 'closed' && (
                          <button
                            onClick={() => updateIncidentField(selectedIncident.id, { affected_asset_ids: selectedIncident.affectedAssetIds.filter(x => x !== aid) })}
                            className="text-red-400 hover:text-red-300 ml-1"
                          >&times;</button>
                        )}
                      </span>
                    );
                  })}
                </div>
                {selectedIncident.status !== 'closed' && allAssets.length > 0 && (
                  <select
                    className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-400 w-full"
                    value=""
                    onChange={e => {
                      if (!e.target.value) return;
                      const newIds = [...(selectedIncident.affectedAssetIds ?? []), e.target.value];
                      updateIncidentField(selectedIncident.id, { affected_asset_ids: newIds });
                    }}
                  >
                    <option value="">+ Asset verknüpfen...</option>
                    {allAssets
                      .filter(a => !(selectedIncident.affectedAssetIds ?? []).includes(a.id))
                      .map(a => <option key={a.id} value={a.id}>{a.name} ({a.assetType})</option>)}
                  </select>
                )}
              </div>

              {/* Affected Services — with name resolution + add/remove */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Betroffene Services ({selectedIncident.affectedServiceIds?.length ?? 0})</p>
                <div className="flex gap-1 flex-wrap mb-2">
                  {(selectedIncident.affectedServiceIds ?? []).map(sid => {
                    const svc = services.find(s => s.id === sid);
                    return (
                      <span key={sid} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-300 font-mono flex items-center gap-1">
                        {svc ? svc.name : sid.slice(0, 8)}
                        {selectedIncident.status !== 'closed' && (
                          <button
                            onClick={() => updateIncidentField(selectedIncident.id, { affected_service_ids: selectedIncident.affectedServiceIds.filter(x => x !== sid) })}
                            className="text-red-400 hover:text-red-300 ml-1"
                          >&times;</button>
                        )}
                      </span>
                    );
                  })}
                </div>
                {selectedIncident.status !== 'closed' && services.length > 0 && (
                  <select
                    className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-400 w-full"
                    value=""
                    onChange={e => {
                      if (!e.target.value) return;
                      const newIds = [...(selectedIncident.affectedServiceIds ?? []), e.target.value];
                      updateIncidentField(selectedIncident.id, { affected_service_ids: newIds });
                    }}
                  >
                    <option value="">+ Service verknüpfen...</option>
                    {services
                      .filter(s => !(selectedIncident.affectedServiceIds ?? []).includes(s.id))
                      .map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
              </div>

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
                  <button onClick={() => openTransitionModal(selectedIncident.id, 'acknowledged')} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded">Acknowledge</button>
                )}
                {(selectedIncident.status === 'open' || selectedIncident.status === 'acknowledged') && (
                  <button onClick={() => openTransitionModal(selectedIncident.id, 'investigating')} className="px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded">Investigate</button>
                )}
                {(selectedIncident.status === 'investigating') && (
                  <button onClick={() => openTransitionModal(selectedIncident.id, 'mitigating')} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded">Mitigate</button>
                )}
                {selectedIncident.status !== 'resolved' && selectedIncident.status !== 'closed' && (
                  <button onClick={() => openTransitionModal(selectedIncident.id, 'resolved')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded">Resolve</button>
                )}
                {selectedIncident.status !== 'closed' && (
                  <button onClick={() => openTransitionModal(selectedIncident.id, 'closed')} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">Close</button>
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
            {/* v645 — Stats */}
            <div className="flex gap-2 flex-wrap text-xs">
              <StatChip active={chgStatusFilter === 'active'} onClick={() => setChgStatusFilter('active')} label="Aktiv" value={chgStats.pending + chgStats.approved + chgStats.in_progress} tone="blue" />
              <StatChip active={chgStatusFilter === 'pending'} onClick={() => setChgStatusFilter('pending')} label="Pending" value={chgStats.pending} tone="amber" />
              <StatChip active={chgStatusFilter === 'approved'} onClick={() => setChgStatusFilter('approved')} label="Approved" value={chgStats.approved} tone="emerald" />
              <StatChip active={chgStatusFilter === 'in_progress'} onClick={() => setChgStatusFilter('in_progress')} label="In Progress" value={chgStats.in_progress} tone="blue" />
              <StatChip active={chgStatusFilter === 'completed'} onClick={() => setChgStatusFilter('completed')} label="Completed" value={chgStats.completed} tone="gray" />
              {chgStats.failed > 0 && <StatChip active={chgStatusFilter === 'failed'} onClick={() => setChgStatusFilter('failed')} label="Failed" value={chgStats.failed} tone="red" />}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={chgStatusFilter} onChange={e => setChgStatusFilter(e.target.value)}>
                <option value="active">⚡ Alle aktiv (default)</option>
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
            {/* v645 — Bulk-Toolbar Changes */}
            {selectedChangeIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-200"><strong>{selectedChangeIds.size}</strong> Change(s) ausgewählt</span>
                <div className="flex-1" />
                <button onClick={() => setSelectedChangeIds(new Set())} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Löschen</button>
                <button onClick={() => bulkChangeAction('approve')} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 rounded hover:bg-emerald-600/50 disabled:opacity-50">✓ Approve</button>
                <button onClick={() => bulkChangeAction('reject')} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-red-600/30 border border-red-500/40 text-red-200 rounded hover:bg-red-600/50 disabled:opacity-50">✕ Reject</button>
              </div>
            )}

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={filteredChanges.length > 0 && filteredChanges.every(c => selectedChangeIds.has(c.id))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedChangeIds(new Set(filteredChanges.map(c => c.id)));
                          else setSelectedChangeIds(new Set());
                        }}
                      />
                    </th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Titel</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Typ</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Risiko</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Geplant</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredChanges.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Keine Change Requests gefunden.</td></tr>
                  )}
                  {filteredChanges.map(chg => (
                    <tr
                      key={chg.id}
                      onClick={() => setSelectedChange(chg)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedChangeIds.has(chg.id) ? 'bg-blue-500/10' :
                          selectedChange?.id === chg.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-2 py-2" onClick={(e) => { e.stopPropagation(); toggleChgSel(chg.id); }}>
                        <input
                          type="checkbox"
                          checked={selectedChangeIds.has(chg.id)}
                          onChange={() => toggleChgSel(chg.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
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

              <EditableTextField label="Beschreibung" value={selectedChange.description} placeholder="Beschreibung der Änderung..."
                onSave={val => updateChangeField(selectedChange.id, { description: val })}
                disabled={selectedChange.status === 'completed' || selectedChange.status === 'rolled_back' || selectedChange.status === 'cancelled'} />

              <EditableTextField label="Implementation Plan" value={selectedChange.implementationPlan} placeholder="Schritte zur Umsetzung..."
                onSave={val => updateChangeField(selectedChange.id, { implementation_plan: val })}
                disabled={selectedChange.status === 'completed' || selectedChange.status === 'rolled_back' || selectedChange.status === 'cancelled'} />

              <EditableTextField label="Rollback Plan" value={selectedChange.rollbackPlan} placeholder="Schritte zum Rückgängigmachen..."
                onSave={val => updateChangeField(selectedChange.id, { rollback_plan: val })}
                disabled={selectedChange.status === 'completed' || selectedChange.status === 'rolled_back' || selectedChange.status === 'cancelled'} />

              <EditableTextField label="Test Plan" value={selectedChange.testPlan} placeholder="Wie wird die Änderung getestet?"
                onSave={val => updateChangeField(selectedChange.id, { test_plan: val })}
                disabled={selectedChange.status === 'completed' || selectedChange.status === 'rolled_back' || selectedChange.status === 'cancelled'} />

              {selectedChange.result && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Ergebnis</p>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedChange.result}</p>
                </div>
              )}

              {/* Betroffene Assets — mit Name-Auflösung + Picker */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Betroffene Assets ({selectedChange.affectedAssetIds?.length ?? 0})</p>
                <div className="flex gap-1 flex-wrap mb-2">
                  {(selectedChange.affectedAssetIds ?? []).map(aid => {
                    const asset = allAssets.find(a => a.id === aid);
                    return (
                      <span key={aid} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-300 font-mono flex items-center gap-1">
                        {asset ? `${asset.name} (${asset.assetType})` : aid.slice(0, 8)}
                        {!['completed', 'rolled_back', 'cancelled'].includes(selectedChange.status) && (
                          <button onClick={() => updateChangeField(selectedChange.id, { affected_asset_ids: selectedChange.affectedAssetIds.filter(x => x !== aid) })}
                            className="text-red-400 hover:text-red-300 ml-1">&times;</button>
                        )}
                      </span>
                    );
                  })}
                </div>
                {!['completed', 'rolled_back', 'cancelled'].includes(selectedChange.status) && allAssets.length > 0 && (
                  <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-xs text-gray-400 w-full" value=""
                    onChange={e => { if (!e.target.value) return; updateChangeField(selectedChange.id, { affected_asset_ids: [...(selectedChange.affectedAssetIds ?? []), e.target.value] }); }}>
                    <option value="">+ Asset verknüpfen...</option>
                    {allAssets.filter(a => !(selectedChange.affectedAssetIds ?? []).includes(a.id)).map(a => <option key={a.id} value={a.id}>{a.name} ({a.assetType})</option>)}
                  </select>
                )}
              </div>

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

              {/* Action Buttons — mit Modal für Pflichtfelder */}
              <div className="flex gap-2 flex-wrap pt-2 border-t border-[#1f1f1f]">
                {(selectedChange.status === 'draft' || selectedChange.status === 'pending') && (
                  <button onClick={() => openChangeTransition(selectedChange.id, 'approved')} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">Approve</button>
                )}
                {selectedChange.status === 'approved' && (
                  <button onClick={() => openChangeTransition(selectedChange.id, 'in_progress')} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded">Start</button>
                )}
                {selectedChange.status === 'in_progress' && (
                  <button onClick={() => openChangeTransition(selectedChange.id, 'completed')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded">Complete</button>
                )}
                {(selectedChange.status === 'in_progress' || selectedChange.status === 'completed') && (
                  <button onClick={() => openChangeTransition(selectedChange.id, 'rolled_back')} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded">Rollback</button>
                )}
                {selectedChange.status !== 'completed' && selectedChange.status !== 'rolled_back' && selectedChange.status !== 'cancelled' && (
                  <button onClick={() => openChangeTransition(selectedChange.id, 'cancelled')} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">Cancel</button>
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
            {/* v645 — Stats */}
            <div className="flex gap-2 flex-wrap text-xs">
              <StatChip active={false} onClick={() => {}} label="✅ Healthy" value={svcStats.healthy} tone="emerald" />
              <StatChip active={false} onClick={() => {}} label="🟡 Degraded" value={svcStats.degraded} tone="amber" />
              <StatChip active={false} onClick={() => {}} label="🔴 Down" value={svcStats.down} tone="red" />
              <StatChip active={false} onClick={() => {}} label="❓ Unknown" value={svcStats.unknown} tone="gray" />
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={runHealthCheck} className="px-3 py-1.5 text-sm bg-green-700 hover:bg-green-600 text-white rounded">Health Check All</button>
              <div className="flex-1" />
              <button onClick={() => setShowCreateService(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Service
              </button>
            </div>
            {/* v645 — Bulk-Toolbar Services */}
            {selectedServiceIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-200"><strong>{selectedServiceIds.size}</strong> Service(s) ausgewählt</span>
                <div className="flex-1" />
                <button onClick={() => setSelectedServiceIds(new Set())} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Löschen</button>
                <button onClick={bulkServiceHealthCheck} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 rounded hover:bg-emerald-600/50 disabled:opacity-50">🩺 Health-Check</button>
              </div>
            )}

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={services.length > 0 && services.every(s => selectedServiceIds.has(s.id))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedServiceIds(new Set(services.map(s => s.id)));
                          else setSelectedServiceIds(new Set());
                        }}
                      />
                    </th>
                    <th className="text-left px-4 py-2 font-medium w-8">H</th>
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Kategorie</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Criticality</th>
                    <th className="text-left px-4 py-2 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {services.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Keine Services gefunden.</td></tr>
                  )}
                  {services.map(svc => (
                    <tr
                      key={svc.id}
                      onClick={() => setSelectedService(svc)}
                      className={clsx(
                        'border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedServiceIds.has(svc.id) && 'bg-blue-500/10',
                        selectedService?.id === svc.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]',
                      )}
                    >
                      <td className="px-2 py-2" onClick={(e) => { e.stopPropagation(); toggleSvcSel(svc.id); }}>
                        <input type="checkbox" checked={selectedServiceIds.has(svc.id)} onChange={() => toggleSvcSel(svc.id)} onClick={(e) => e.stopPropagation()} />
                      </td>
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

              {selectedService.healthReason && (
                <p className={clsx('text-xs', selectedService.healthStatus === 'down' ? 'text-red-400' : 'text-yellow-400')}>
                  {'\u26a0\ufe0f'} Grund: {selectedService.healthReason}
                </p>
              )}

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

              {/* Komponenten */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Komponenten</p>
                {(!selectedService.components || selectedService.components.length === 0) ? (
                  <p className="text-xs text-gray-500 italic">Keine Komponenten definiert.</p>
                ) : (
                  <div className="space-y-1.5">
                    {selectedService.components.map((comp, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2">
                        <span className={clsx('w-2 h-2 rounded-full mt-0.5 shrink-0', {
                          'bg-green-500': comp.healthStatus === 'healthy',
                          'bg-yellow-500': comp.healthStatus === 'degraded',
                          'bg-red-500': comp.healthStatus === 'down',
                          'bg-gray-500': !comp.healthStatus || comp.healthStatus === 'unknown',
                        })} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-gray-200">{comp.name}</span>
                            <span className="text-gray-500">({comp.role})</span>
                            {comp.required && <span className="text-[10px] px-1.5 py-0 rounded bg-orange-500/10 text-orange-400">required</span>}
                          </div>
                          {comp.healthReason && (
                            <p className={clsx('mt-0.5', comp.healthStatus === 'down' ? 'text-red-400' : 'text-yellow-400')}>
                              {comp.healthReason}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

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

      {/* ============= PROBLEMS TAB ============= */}
      {!loading && tab === 'problems' && (
        <div className="flex gap-6">
          <div className={clsx('space-y-3', selectedProblem ? 'w-1/2' : 'w-full')}>
            {/* v645 — Stats */}
            <div className="flex gap-2 flex-wrap text-xs">
              <StatChip active={prbStatusFilter2 === 'active'} onClick={() => setPrbStatusFilter2('active')} label="Aktiv" value={prbStats.open + prbStats.analyzing + prbStats.root_cause_identified} tone="blue" />
              <StatChip active={prbStatusFilter2 === 'open'} onClick={() => setPrbStatusFilter2('open')} label="Open" value={prbStats.open} tone="red" />
              <StatChip active={prbStatusFilter2 === 'analyzing'} onClick={() => setPrbStatusFilter2('analyzing')} label="Analyzing" value={prbStats.analyzing} tone="amber" />
              <StatChip active={prbStatusFilter2 === 'root_cause_identified'} onClick={() => setPrbStatusFilter2('root_cause_identified')} label="Root Cause" value={prbStats.root_cause_identified} tone="amber" />
              <StatChip active={prbStatusFilter2 === 'resolved'} onClick={() => setPrbStatusFilter2('resolved')} label="Resolved" value={prbStats.resolved} tone="emerald" />
              <StatChip active={prbStatusFilter2 === 'closed'} onClick={() => setPrbStatusFilter2('closed')} label="Closed" value={prbStats.closed} tone="gray" />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={prbStatusFilter2} onChange={e => setPrbStatusFilter2(e.target.value)}>
                <option value="active">⚡ Alle aktiv (default)</option>
                <option value="">Alle Status</option>
                <option value="open">Open</option>
                <option value="analyzing">Analyzing</option>
                <option value="root_cause_identified">Root Cause ID</option>
                <option value="fix_in_progress">Fix in Progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <select className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200" value={probPriorityFilter} onChange={e => setProbPriorityFilter(e.target.value)}>
                <option value="">Alle Prioritäten</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <div className="flex-1" />
              <button onClick={() => setShowCreateProblem(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1">
                <span>+</span> Problem
              </button>
            </div>
            {/* v645 — Bulk-Toolbar Problems */}
            {selectedProblemIds2.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-200"><strong>{selectedProblemIds2.size}</strong> Problem(e) ausgewählt</span>
                <div className="flex-1" />
                <button onClick={() => setSelectedProblemIds2(new Set())} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Löschen</button>
                <button onClick={startBulkProblemStatus} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-blue-600/30 border border-blue-500/40 text-blue-200 rounded hover:bg-blue-600/50 disabled:opacity-50">Status</button>
                <button onClick={bulkProblemMarkKnownError} disabled={bulkBusy2} className="px-2 py-1 text-xs bg-amber-600/30 border border-amber-500/40 text-amber-200 rounded hover:bg-amber-600/50 disabled:opacity-50">⚠ Known-Error</button>
              </div>
            )}

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#0d0d0d] text-gray-400">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={filteredProblems2.length > 0 && filteredProblems2.every(p => selectedProblemIds2.has(p.id))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedProblemIds2(new Set(filteredProblems2.map(p => p.id)));
                          else setSelectedProblemIds2(new Set());
                        }}
                      />
                    </th>
                    <th className="text-left px-4 py-2 font-medium w-8">P</th>
                    <th className="text-left px-4 py-2 font-medium">Titel</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Inc</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">KE</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Erkannt</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProblems2.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Keine Probleme gefunden.</td></tr>
                  )}
                  {filteredProblems2.filter(p => !probPriorityFilter || p.priority === probPriorityFilter).map(prob => (
                    <tr key={prob.id} onClick={() => setSelectedProblem(prob)}
                      className={clsx('border-t border-[#1f1f1f] cursor-pointer transition-colors',
                        selectedProblemIds2.has(prob.id) ? 'bg-blue-500/10' :
                        selectedProblem?.id === prob.id ? 'bg-blue-500/5' : 'hover:bg-[#1a1a1a]')}>
                      <td className="px-2 py-2" onClick={(e) => { e.stopPropagation(); togglePrbSel(prob.id); }}>
                        <input type="checkbox" checked={selectedProblemIds2.has(prob.id)} onChange={() => togglePrbSel(prob.id)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td className="px-4 py-2"><span className={SEV_COLORS[prob.priority]}>{SEV_ICONS[prob.priority] ?? '●'}</span></td>
                      <td className="px-4 py-2 text-gray-200">{prob.title}</td>
                      <td className="px-4 py-2"><span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(prob.status))}>{prob.status}</span></td>
                      <td className="px-4 py-2 text-gray-400 text-xs hidden md:table-cell">{prob.linkedIncidentIds?.length ?? 0}</td>
                      <td className="px-4 py-2 hidden md:table-cell">{prob.isKnownError ? <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">KE</span> : '—'}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs hidden md:table-cell">{fmtDate(prob.detectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Problem Detail */}
          {selectedProblem && (
            <div className="w-1/2 bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 space-y-4 overflow-y-auto max-h-[calc(100vh-220px)]">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-200">{selectedProblem.title}</h3>
                  <p className="text-xs text-gray-500 mt-1">ID: {selectedProblem.id}</p>
                </div>
                <button onClick={() => setSelectedProblem(null)} className="text-gray-500 hover:text-gray-300 text-lg">x</button>
              </div>

              <div className="flex gap-2 flex-wrap items-center">
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', SEV_BG[selectedProblem.priority])}>{selectedProblem.priority}</span>
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', statusBadge(selectedProblem.status))}>{selectedProblem.status}</span>
                {selectedProblem.category && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">{selectedProblem.category}</span>}
                {selectedProblem.isKnownError && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">Known Error</span>}
              </div>

              <EditableTextField label="Beschreibung" value={selectedProblem.description} placeholder="Problem-Beschreibung..."
                onSave={val => updateProblemField(selectedProblem.id, { description: val })}
                disabled={selectedProblem.status === 'closed'} />

              <EditableTextField label="Root Cause" value={selectedProblem.rootCauseDescription} placeholder="Was ist die Ursache?"
                onSave={val => updateProblemField(selectedProblem.id, { root_cause_description: val })}
                disabled={selectedProblem.status === 'closed'} />

              <EditableTextField label="Workaround" value={selectedProblem.workaround} placeholder="Temporärer Workaround..."
                onSave={val => updateProblemField(selectedProblem.id, { workaround: val })}
                disabled={selectedProblem.status === 'closed'} />

              <EditableTextField label="Proposed Fix" value={selectedProblem.proposedFix} placeholder="Permanenter Lösungsvorschlag..."
                onSave={val => updateProblemField(selectedProblem.id, { proposed_fix: val })}
                disabled={selectedProblem.status === 'closed'} />

              {/* Known Error Toggle */}
              {selectedProblem.status !== 'closed' && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded p-3 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-amber-400 cursor-pointer">
                    <input type="checkbox" checked={selectedProblem.isKnownError}
                      onChange={e => updateProblemField(selectedProblem.id, { is_known_error: e.target.checked })} />
                    Known Error (Root Cause bekannt, Fix ausstehend)
                  </label>
                  {selectedProblem.isKnownError && (
                    <EditableTextField label="Known Error Beschreibung" value={selectedProblem.knownErrorDescription} placeholder="Bekannte Ursache + Workaround..."
                      onSave={val => updateProblemField(selectedProblem.id, { known_error_description: val })} />
                  )}
                </div>
              )}

              {/* Analysis Notes — append-only */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Analyse-Notizen</p>
                {selectedProblem.analysisNotes ? (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap mb-2">{selectedProblem.analysisNotes}</p>
                ) : (
                  <p className="text-xs text-gray-500 italic mb-2">Keine Notizen vorhanden.</p>
                )}
                {selectedProblem.status !== 'closed' && (
                  addingAnalysisNote ? (
                    <div className="space-y-2">
                      <textarea className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[60px]"
                        placeholder="Analyse, Beobachtung, Hypothese..." value={analysisNoteText} onChange={e => setAnalysisNoteText(e.target.value)} />
                      <div className="flex gap-2">
                        <button onClick={async () => { if (!analysisNoteText.trim()) return; await updateProblemField(selectedProblem.id, { analysis_notes: analysisNoteText.trim() }); setAnalysisNoteText(''); setAddingAnalysisNote(false); }}
                          className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">Speichern</button>
                        <button onClick={() => { setAddingAnalysisNote(false); setAnalysisNoteText(''); }} className="px-3 py-1 text-xs text-gray-400 hover:text-white">Abbrechen</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setAddingAnalysisNote(true)} className="text-xs text-blue-400 hover:text-blue-300">+ Notiz hinzufügen</button>
                  )
                )}
              </div>

              {/* Linked Incidents */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Verknüpfte Incidents ({selectedProblem.linkedIncidentIds?.length ?? 0})</p>
                <div className="flex gap-1 flex-wrap mb-2">
                  {(selectedProblem.linkedIncidentIds ?? []).map(incId => {
                    const inc = incidents.find(i => i.id === incId);
                    return (
                      <span key={incId} className="text-xs bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-0.5 text-gray-300 font-mono flex items-center gap-1">
                        {inc ? `${inc.title.slice(0, 30)}` : incId.slice(0, 8)}
                        {inc && <span className={clsx('text-[10px] px-1 rounded', statusBadge(inc.status))}>{inc.status}</span>}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Linked Change Request */}
              {selectedProblem.linkedChangeRequestId && (
                <div className="bg-[#1a1a1a] rounded p-2">
                  <p className="text-xs text-gray-500 mb-1">Fix-Change Request</p>
                  <p className="text-sm text-blue-400 font-mono">{selectedProblem.linkedChangeRequestId.slice(0, 8)}...</p>
                </div>
              )}

              {/* Timeline */}
              <div>
                <p className="text-xs text-gray-500 mb-2">Timeline</p>
                <div className="space-y-1 text-xs">
                  <div className="flex gap-3"><span className="text-gray-500 w-24">Erkannt:</span><span className="text-gray-300">{fmtDate(selectedProblem.detectedAt)}</span></div>
                  {selectedProblem.analyzedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Analysiert:</span><span className="text-gray-300">{fmtDate(selectedProblem.analyzedAt)}</span></div>}
                  {selectedProblem.rootCauseIdentifiedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Root Cause:</span><span className="text-gray-300">{fmtDate(selectedProblem.rootCauseIdentifiedAt)}</span></div>}
                  {selectedProblem.resolvedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Resolved:</span><span className="text-gray-300">{fmtDate(selectedProblem.resolvedAt)}</span></div>}
                  {selectedProblem.closedAt && <div className="flex gap-3"><span className="text-gray-500 w-24">Closed:</span><span className="text-gray-300">{fmtDate(selectedProblem.closedAt)}</span></div>}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 flex-wrap pt-2 border-t border-[#1f1f1f]">
                {selectedProblem.status === 'logged' && (
                  <button onClick={() => openProblemTransition(selectedProblem.id, 'analyzing')} className="px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded">Analyze</button>
                )}
                {selectedProblem.status === 'analyzing' && (
                  <button onClick={() => openProblemTransition(selectedProblem.id, 'root_cause_identified')} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded">Root Cause</button>
                )}
                {selectedProblem.status === 'root_cause_identified' && (
                  <button onClick={() => openProblemTransition(selectedProblem.id, 'fix_in_progress')} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded">Fix starten</button>
                )}
                {selectedProblem.status !== 'resolved' && selectedProblem.status !== 'closed' && (
                  <button onClick={() => openProblemTransition(selectedProblem.id, 'resolved')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded">Resolve</button>
                )}
                {selectedProblem.status === 'resolved' && (
                  <button onClick={() => openProblemTransition(selectedProblem.id, 'closed')} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">Close</button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Modals */}
      {showCreateIncident && <CreateIncidentModal onClose={() => setShowCreateIncident(false)} onSave={createIncident} />}
      {showCreateChange && <CreateChangeModal onClose={() => setShowCreateChange(false)} onSave={createChange} />}
      {showCreateService && <CreateServiceModal onClose={() => setShowCreateService(false)} onSave={createService} />}

      {/* Create Problem Modal */}
      {showCreateProblem && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreateProblem(false)}>
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-200">Neues Problem</h3>
            <input id="prob-title" className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" placeholder="Titel" />
            <div className="flex gap-2">
              <select id="prob-priority" className="flex-1 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" defaultValue="medium">
                <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select>
              <select id="prob-category" className="flex-1 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200" defaultValue="">
                <option value="">Kategorie...</option>
                <option value="infrastructure">Infrastructure</option><option value="software">Software</option><option value="configuration">Configuration</option>
                <option value="capacity">Capacity</option><option value="security">Security</option><option value="network">Network</option><option value="unknown">Unknown</option>
              </select>
            </div>
            <textarea id="prob-desc" className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 h-24" placeholder="Beschreibung" />
            <textarea id="prob-wa" className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 h-16" placeholder="Workaround (optional)" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCreateProblem(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button onClick={() => {
                const title = (document.getElementById('prob-title') as HTMLInputElement)?.value;
                if (!title) return;
                createProblem({
                  title,
                  priority: (document.getElementById('prob-priority') as HTMLSelectElement)?.value as any,
                  category: (document.getElementById('prob-category') as HTMLSelectElement)?.value || undefined,
                  description: (document.getElementById('prob-desc') as HTMLTextAreaElement)?.value || undefined,
                  workaround: (document.getElementById('prob-wa') as HTMLTextAreaElement)?.value || undefined,
                } as any);
              }} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Erstellen</button>
            </div>
          </div>
        </div>
      )}

      {/* Status Transition Modal */}
      {transitionModal && transitionModal.fields.length > 0 && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">Incident → {transitionModal.label}</h3>
            {transitionModal.fields.map(f => (
              <div key={f.key}>
                <label className="text-xs text-gray-400 mb-1 block">
                  {f.label} {f.required && <span className="text-red-400">*</span>}
                </label>
                <textarea
                  className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[80px]"
                  placeholder={f.placeholder}
                  value={transitionFields[f.key] ?? ''}
                  onChange={e => setTransitionFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setTransitionModal(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button
                onClick={() => {
                  const missing = transitionModal.fields.filter(f => f.required && !transitionFields[f.key]?.trim());
                  if (missing.length > 0) { setError(`Pflichtfeld: ${missing.map(f => f.label).join(', ')}`); return; }
                  submitTransition(transitionModal.incidentId, transitionModal.targetStatus, transitionFields);
                }}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                {transitionModal.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Transition Modal */}
      {changeTransitionModal && changeTransitionModal.fields.length > 0 && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">Change → {changeTransitionModal.label}</h3>
            {changeTransitionModal.fields.map(f => (
              <div key={f.key}>
                <label className="text-xs text-gray-400 mb-1 block">
                  {f.label} {f.required && <span className="text-red-400">*</span>}
                </label>
                <textarea
                  className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[80px]"
                  placeholder={f.placeholder}
                  value={changeTransitionFields[f.key] ?? ''}
                  onChange={e => setChangeTransitionFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setChangeTransitionModal(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button
                onClick={() => {
                  const missing = changeTransitionModal.fields.filter(f => f.required && !changeTransitionFields[f.key]?.trim());
                  if (missing.length > 0) { setError(`Pflichtfeld: ${missing.map(f => f.label).join(', ')}`); return; }
                  submitChangeTransition(changeTransitionModal.incidentId, changeTransitionModal.targetStatus, changeTransitionFields);
                }}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                {changeTransitionModal.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Problem Transition Modal */}
      {problemTransitionModal && problemTransitionModal.fields.length > 0 && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">Problem → {problemTransitionModal.label}</h3>
            {problemTransitionModal.fields.map(f => (
              <div key={f.key}>
                <label className="text-xs text-gray-400 mb-1 block">{f.label} {f.required && <span className="text-red-400">*</span>}</label>
                <textarea className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200 min-h-[80px]"
                  placeholder={f.placeholder} value={problemTransitionFields[f.key] ?? ''}
                  onChange={e => setProblemTransitionFields(prev => ({ ...prev, [f.key]: e.target.value }))} />
              </div>
            ))}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setProblemTransitionModal(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button onClick={() => {
                const missing = problemTransitionModal.fields.filter(f => f.required && !problemTransitionFields[f.key]?.trim());
                if (missing.length > 0) { setError(`Pflichtfeld: ${missing.map(f => f.label).join(', ')}`); return; }
                submitProblemTransition(problemTransitionModal.incidentId, problemTransitionModal.targetStatus, problemTransitionFields);
              }} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">{problemTransitionModal.label}</button>
            </div>
          </div>
        </div>
      )}

      {/* v632 — Patterns Tab */}
      {!loading && tab === 'patterns' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-sm text-gray-300">
              Erkannte Incident-Cluster (mind. {patternMinIncidents} verwandte Incidents in {patternWindowDays}d).
            </div>
            <div className="flex-1" />
            <label className="text-xs text-gray-400 flex items-center gap-1">
              Fenster (Tage):
              <input
                type="number" min={1} max={90} value={patternWindowDays}
                onChange={(e) => setPatternWindowDays(Math.max(1, Number(e.target.value) || 14))}
                className="w-16 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-gray-200"
              />
            </label>
            <label className="text-xs text-gray-400 flex items-center gap-1">
              Min. Incidents:
              <input
                type="number" min={2} max={20} value={patternMinIncidents}
                onChange={(e) => setPatternMinIncidents(Math.max(2, Number(e.target.value) || 2))}
                className="w-14 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-gray-200"
              />
            </label>
            <button onClick={loadPatterns} disabled={patternsLoading} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
              {patternsLoading ? 'Analysiere …' : '🔍 Analysieren'}
            </button>
          </div>

          {patterns.length === 0 && !patternsLoading && (
            <div className="text-center text-gray-500 text-sm border border-dashed border-[#2a2a2a] rounded p-8">
              Keine Cluster gefunden — entweder ist alles aufgeräumt, oder Schwellwerte hochsetzen.
            </div>
          )}

          {patterns.map(p => (
            <div key={p.patternKey} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold text-amber-400">{p.incidentCount}×</span>
                  <span className="text-sm text-gray-200">
                    {p.keywordCluster.slice(0, 5).join(', ') || 'unbenannt'}
                  </span>
                </div>
                {p.existingProblemId ? (
                  <span className="text-xs px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                    bereits gelinkt → Problem {p.existingProblemId.slice(0, 8)}
                  </span>
                ) : (
                  <button
                    onClick={() => promoteFromPattern(p)}
                    disabled={bulkBusy}
                    className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50"
                  >+ Als Problem promoten</button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-gray-400">
                <div><div className="text-gray-500">Zeitraum</div><div className="text-gray-300">{fmtDate(p.firstSeen).slice(0, 10)} – {fmtDate(p.lastSeen).slice(0, 10)}</div></div>
                <div><div className="text-gray-500">Assets</div><div className="text-gray-300">{p.assetIds.length}</div></div>
                <div><div className="text-gray-500">Services</div><div className="text-gray-300">{p.serviceIds.length}</div></div>
                <div><div className="text-gray-500">Incidents</div><div className="text-gray-300">{p.incidentIds.length}</div></div>
              </div>
              <details className="mt-2 text-xs">
                <summary className="text-gray-500 cursor-pointer hover:text-gray-300">Linked Incidents anzeigen</summary>
                <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                  {p.incidentIds.map(iid => {
                    const inc = incidents.find(i => i.id === iid);
                    return (
                      <div key={iid} className="font-mono text-[10px] text-gray-400">
                        {iid.slice(0, 8)} {inc ? `· ${inc.title}` : ''}
                      </div>
                    );
                  })}
                </div>
              </details>
            </div>
          ))}
        </div>
      )}

      {/* v632 — Bulk-Merge Modal */}
      {bulkMergeMode && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">
              {bulkMergeMode === 'new-problem' ? 'Neues Problem aus Auswahl' : 'Auswahl mit bestehendem Problem verknüpfen'}
            </h3>
            <p className="text-sm text-gray-400">
              <strong>{selectedIncidentIds.size}</strong> Incident(s) werden {bulkMergeMode === 'new-problem' ? 'mit einem neuen Problem-Ticket verknüpft' : 'an das gewählte Problem angehängt'}.
            </p>
            {bulkMergeMode === 'new-problem' && (
              <>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Titel</label>
                  <input
                    value={bulkMergeTitle}
                    onChange={(e) => setBulkMergeTitle(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Priorität</label>
                  <select
                    value={bulkMergePriority}
                    onChange={(e) => setBulkMergePriority(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </div>
              </>
            )}
            {bulkMergeMode === 'existing-problem' && (
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Problem auswählen</label>
                <select
                  value={bulkMergeProblemId}
                  onChange={(e) => setBulkMergeProblemId(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
                >
                  <option value="">— wähle ein Problem —</option>
                  {problems.map(p => (
                    <option key={p.id} value={p.id}>{p.title} ({p.id.slice(0, 8)})</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setBulkMergeMode(null)} disabled={bulkBusy} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button onClick={executeBulkMerge} disabled={bulkBusy} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
                {bulkBusy ? 'Wird ausgeführt …' : (bulkMergeMode === 'new-problem' ? 'Problem erstellen' : 'Verknüpfen')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* v645 — Bulk-Action Modal (Incident-Close / Severity / Problem-Status) */}
      {bulkModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#1f1f1f] rounded-xl p-5 w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold text-white">
              {bulkModal.kind === 'inc-close' && '✕ Bulk-Close Incidents'}
              {bulkModal.kind === 'inc-sev' && '⚠ Bulk-Severity-Change'}
              {bulkModal.kind === 'prb-status' && 'Bulk-Status-Change'}
            </h3>
            <p className="text-xs text-gray-400">{bulkModal.ids.length} ausgewählt</p>
            {bulkModal.kind === 'inc-close' && (
              <textarea
                placeholder="Resolution (für alle, Pflicht)"
                value={bulkParams.resolution ?? ''}
                onChange={(e) => setBulkParams(p => ({ ...p, resolution: e.target.value }))}
                rows={4}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
              />
            )}
            {bulkModal.kind === 'inc-sev' && (
              <select
                value={bulkParams.severity ?? 'high'}
                onChange={(e) => setBulkParams(p => ({ ...p, severity: e.target.value }))}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
              >
                <option value="critical">🔴 critical</option>
                <option value="high">🟠 high</option>
                <option value="medium">🟡 medium</option>
                <option value="low">⚪ low</option>
              </select>
            )}
            {bulkModal.kind === 'prb-status' && (
              <select
                value={bulkParams.status ?? 'analyzing'}
                onChange={(e) => setBulkParams(p => ({ ...p, status: e.target.value }))}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
              >
                <option value="analyzing">analyzing</option>
                <option value="root_cause_identified">root_cause_identified</option>
                <option value="fix_in_progress">fix_in_progress</option>
                <option value="resolved">resolved</option>
                <option value="closed">closed</option>
              </select>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setBulkModal(null)} disabled={bulkBusy2} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Abbrechen</button>
              <button onClick={executeBulkInc} disabled={bulkBusy2} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">
                {bulkBusy2 ? '…' : 'Ausführen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// v645 — Stats-Chip mit Filter-Click
function StatChip({ label, value, tone, active, onClick }: { label: string; value: number; tone: 'red' | 'amber' | 'emerald' | 'blue' | 'gray'; active: boolean; onClick: () => void }) {
  const toneClass: Record<string, string> = {
    red: 'border-red-500/40 text-red-300',
    amber: 'border-amber-500/40 text-amber-300',
    emerald: 'border-emerald-500/40 text-emerald-300',
    blue: 'border-blue-500/40 text-blue-300',
    gray: 'border-gray-500/40 text-gray-400',
  };
  const activeBg: Record<string, string> = {
    red: 'bg-red-500/15', amber: 'bg-amber-500/15', emerald: 'bg-emerald-500/15', blue: 'bg-blue-500/15', gray: 'bg-gray-500/15',
  };
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 border rounded inline-flex items-baseline gap-1.5 ${toneClass[tone]} ${active ? activeBg[tone] : 'bg-transparent hover:bg-[#161616]'}`}
    >
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <span className="text-sm font-mono">{value}</span>
    </button>
  );
}
