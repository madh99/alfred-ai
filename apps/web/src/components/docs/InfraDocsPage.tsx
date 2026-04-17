'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useConfig } from '@/context/ConfigContext';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DocTree, DocTreeNode, DocDetail } from '@/types/api';

// ── Constants ──

const DOC_TYPE_ICONS: Record<string, string> = {
  system_doc: '\uD83D\uDDA5\uFE0F',
  service_doc: '\u2699\uFE0F',
  setup_guide: '\uD83D\uDCD6',
  config_snapshot: '\uD83D\uDCF8',
  runbook: '\uD83D\uDCCB',
  sop: '\uD83D\uDCDD',
  network_doc: '\uD83C\uDF10',
  policy: '\uD83D\uDCDC',
  postmortem: '\uD83D\uDD0D',
  inventory: '\uD83D\uDCE6',
  inventory_report: '\uD83D\uDCE6',
  topology: '\uD83D\uDD17',
  topology_diagram: '\uD83D\uDD17',
  service_map: '\uD83D\uDDFA\uFE0F',
  change_log: '\uD83D\uDCDD',
  custom: '\uD83D\uDCC4',
};

const DOC_TYPE_LABELS: Record<string, string> = {
  system_doc: 'System',
  service_doc: 'Service',
  setup_guide: 'Setup',
  config_snapshot: 'Config',
  runbook: 'Runbook',
  sop: 'SOP',
  network_doc: 'Netzwerk',
  policy: 'Policy',
  postmortem: 'Postmortem',
  inventory: 'Inventar',
  inventory_report: 'Inventar',
  topology: 'Topologie',
  topology_diagram: 'Topologie',
  service_map: 'Service Map',
  change_log: 'Changelog',
  custom: 'Sonstige',
};

const ASSET_TYPE_ICONS: Record<string, string> = {
  server: '\uD83D\uDDA5\uFE0F',
  vm: '\uD83D\uDCBB',
  container: '\uD83D\uDCE6',
  network_device: '\uD83C\uDF10',
  certificate: '\uD83D\uDD10',
  storage: '\uD83D\uDCBE',
};

const GENERATOR_TYPES = [
  { key: 'inventory_report', label: 'Inventar', icon: '\uD83D\uDCE6' },
  { key: 'topology_diagram', label: 'Topologie', icon: '\uD83D\uDD17' },
  { key: 'service_map', label: 'Services', icon: '\u2699\uFE0F' },
  { key: 'change_log', label: 'Changes', icon: '\uD83D\uDCDD' },
  { key: 'export', label: 'Export', icon: '\uD83D\uDCE5' },
  { key: 'generate_system_doc', label: 'System-Doku', icon: '\uD83D\uDDA5\uFE0F', needsAsset: true },
  { key: 'generate_service_doc', label: 'Service-Doku', icon: '\u2699\uFE0F', needsService: true },
  { key: 'generate_network_doc', label: 'Netzwerk-Doku', icon: '\uD83C\uDF10' },
  { key: 'generate_config_snapshot', label: 'Config-Snapshot', icon: '\uD83D\uDCF8', needsAsset: true },
];

type DocRef = { id: string; title: string; docType: string; version: number; createdAt: string };

// ── Markdown components for dark theme ──

const mdComponents = {
  h1: ({ children, ...props }: any) => <h1 className="text-xl font-bold text-white mt-6 mb-3" {...props}>{children}</h1>,
  h2: ({ children, ...props }: any) => <h2 className="text-lg font-bold text-gray-100 mt-6 mb-2 border-b border-[#1f1f1f] pb-1" {...props}>{children}</h2>,
  h3: ({ children, ...props }: any) => <h3 className="text-base font-semibold text-gray-200 mt-5 mb-2" {...props}>{children}</h3>,
  h4: ({ children, ...props }: any) => <h4 className="text-sm font-semibold text-gray-300 mt-4 mb-1" {...props}>{children}</h4>,
  p: ({ children, ...props }: any) => <p className="text-gray-300 leading-relaxed mb-2" {...props}>{children}</p>,
  ul: ({ children, ...props }: any) => <ul className="ml-4 list-disc text-gray-300 space-y-0.5 mb-2" {...props}>{children}</ul>,
  ol: ({ children, ...props }: any) => <ol className="ml-4 list-decimal text-gray-300 space-y-0.5 mb-2" {...props}>{children}</ol>,
  li: ({ children, ...props }: any) => <li className="text-gray-300" {...props}>{children}</li>,
  strong: ({ children, ...props }: any) => <strong className="text-white font-semibold" {...props}>{children}</strong>,
  em: ({ children, ...props }: any) => <em className="text-gray-200" {...props}>{children}</em>,
  a: ({ children, href, ...props }: any) => <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>,
  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    if (isInline) {
      return <code className="bg-[#1a1a1a] text-green-400 px-1.5 py-0.5 rounded text-sm" {...props}>{children}</code>;
    }
    return <code className="text-green-400 text-sm" {...props}>{children}</code>;
  },
  pre: ({ children, ...props }: any) => (
    <pre className="bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg p-4 overflow-x-auto text-sm leading-relaxed my-3" {...props}>{children}</pre>
  ),
  table: ({ children, ...props }: any) => (
    <div className="overflow-x-auto my-3">
      <table className="text-sm w-full border-collapse" {...props}>{children}</table>
    </div>
  ),
  thead: ({ children, ...props }: any) => <thead {...props}>{children}</thead>,
  th: ({ children, ...props }: any) => <th className="text-left px-3 py-1.5 text-gray-400 border-b border-[#2a2a2a] font-medium" {...props}>{children}</th>,
  tr: ({ children, ...props }: any) => <tr className="hover:bg-[#1a1a1a]" {...props}>{children}</tr>,
  td: ({ children, ...props }: any) => <td className="px-3 py-1.5 text-gray-300 border-b border-[#161616]" {...props}>{children}</td>,
  blockquote: ({ children, ...props }: any) => <blockquote className="border-l-2 border-[#2a2a2a] pl-4 text-gray-400 italic my-3" {...props}>{children}</blockquote>,
  hr: (props: any) => <hr className="border-[#1f1f1f] my-4" {...props} />,
};

// ── Spinner ──

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin h-8 w-8 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {label && <span className="text-gray-500 text-sm">{label}</span>}
      </div>
    </div>
  );
}

// ── DocType badge ──

function DocTypeBadge({ docType }: { docType: string }) {
  const icon = DOC_TYPE_ICONS[docType] ?? '\uD83D\uDCC4';
  const label = DOC_TYPE_LABELS[docType] ?? docType;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[#1f1f1f] text-gray-400">
      <span>{icon}</span> {label}
    </span>
  );
}

// ── Main component ──

export function InfraDocsPage() {
  const { client } = useConfig();

  // Tab: 'browser' | 'generator'
  const [activeTab, setActiveTab] = useState<'browser' | 'generator'>('browser');

  // ── Browser state ──
  const [tree, setTree] = useState<DocTree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  // Versions state
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<DocDetail[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDocType, setCreateDocType] = useState('custom');
  const [createContent, setCreateContent] = useState('');
  const [createLinkedEntityType, setCreateLinkedEntityType] = useState('');
  const [createLinkedEntityId, setCreateLinkedEntityId] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── Generator state (old functionality) ──
  const [genType, setGenType] = useState<string | null>(null);
  const [genContent, setGenContent] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [exportData, setExportData] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Load tree ──
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const data = await client.fetchDocTree();
      setTree(data);
      // Expand all groups by default
      const groups = new Set<string>();
      if (data.assets?.length) groups.add('assets');
      if (data.services?.length) groups.add('services');
      if (data.unlinked?.length) groups.add('unlinked');
      data.assets?.forEach((a) => groups.add(`asset-${a.id}`));
      data.services?.forEach((s) => groups.add(`service-${s.id}`));
      setExpandedGroups(groups);
    } catch (err: any) {
      setTreeError(err.message ?? 'Fehler beim Laden');
    } finally {
      setTreeLoading(false);
    }
  }, [client]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // ── Load doc ──
  const loadDoc = useCallback(async (id: string) => {
    setSelectedDocId(id);
    setDocLoading(true);
    setDocError(null);
    setEditing(false);
    setShowVersions(false);
    setConfirmDelete(false);
    try {
      const data = await client.fetchDoc(id);
      setDoc(data);
    } catch (err: any) {
      setDocError(err.message ?? 'Dokument konnte nicht geladen werden');
    } finally {
      setDocLoading(false);
    }
  }, [client]);

  // ── Load versions ──
  const loadVersions = useCallback(async (id: string) => {
    setVersionsLoading(true);
    try {
      const data = await client.fetchDocVersions(id);
      setVersions(data);
      setShowVersions(true);
    } catch {
      // silently fail
    } finally {
      setVersionsLoading(false);
    }
  }, [client]);

  // ── Save (update) ──
  const handleSave = useCallback(async () => {
    if (!doc) return;
    try {
      await client.updateDoc(doc.id, { content: editContent });
      await loadDoc(doc.id);
      setEditing(false);
    } catch (err: any) {
      setDocError(err.message ?? 'Speichern fehlgeschlagen');
    }
  }, [client, doc, editContent, loadDoc]);

  // ── Delete ──
  const handleDelete = useCallback(async () => {
    if (!doc) return;
    const ok = await client.deleteDoc(doc.id);
    if (ok) {
      setDoc(null);
      setSelectedDocId(null);
      setConfirmDelete(false);
      loadTree();
    }
  }, [client, doc, loadTree]);

  // ── Create ──
  const handleCreate = useCallback(async () => {
    setCreateLoading(true);
    try {
      const payload: Record<string, unknown> = {
        title: createTitle,
        doc_type: createDocType,
        content: createContent || `# ${createTitle}\n\n`,
        format: 'markdown',
      };
      if (createLinkedEntityType) payload.linked_entity_type = createLinkedEntityType;
      if (createLinkedEntityId) payload.linked_entity_id = createLinkedEntityId;
      const res = await client.createDoc(payload);
      setShowCreate(false);
      setCreateTitle('');
      setCreateDocType('custom');
      setCreateContent('');
      setCreateLinkedEntityType('');
      setCreateLinkedEntityId('');
      await loadTree();
      if (res?.id) loadDoc(res.id);
    } catch (err: any) {
      setDocError(err.message ?? 'Erstellen fehlgeschlagen');
    } finally {
      setCreateLoading(false);
    }
  }, [client, createTitle, createDocType, createContent, createLinkedEntityType, createLinkedEntityId, loadTree, loadDoc]);

  // ── Toggle group ──
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Filter tree by search ──
  const filteredTree = useMemo(() => {
    if (!tree) return null;
    if (!search.trim()) return tree;
    const q = search.toLowerCase();
    const filterDocs = (docs: DocRef[]) => docs.filter((d) => d.title.toLowerCase().includes(q) || d.docType.toLowerCase().includes(q));
    const filterNodes = (nodes: DocTreeNode[]) =>
      nodes
        .map((n) => ({ ...n, docs: filterDocs(n.docs) }))
        .filter((n) => n.docs.length > 0 || n.name.toLowerCase().includes(q));
    return {
      assets: filterNodes(tree.assets ?? []),
      services: filterNodes(tree.services ?? []),
      unlinked: filterDocs(tree.unlinked ?? []),
    };
  }, [tree, search]);

  // ── Generator functions (old functionality) ──
  const generate = useCallback(async (type: string) => {
    setGenType(type);
    setGenContent('');
    setGenError(null);
    setExportData(null);
    setGenLoading(true);
    try {
      if (type === 'export') {
        const res = await client.docsExport('json');
        if (!res.success) throw new Error(res.display ?? 'Export fehlgeschlagen');
        setExportData(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
        setGenContent(res.display ?? 'Export bereit.');
      } else {
        const res = await client.docsGenerate(type);
        if (!res.success) throw new Error(res.display ?? 'Generierung fehlgeschlagen');
        setGenContent(res.display ?? '');
      }
    } catch (err: any) {
      setGenError(err.message ?? 'Unbekannter Fehler');
    } finally {
      setGenLoading(false);
    }
  }, [client]);

  const handleCopy = useCallback(async () => {
    if (!genContent) return;
    await navigator.clipboard.writeText(genContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [genContent]);

  const handleDownload = useCallback(() => {
    if (!exportData) return;
    const blob = new Blob([exportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alfred-infra-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportData]);

  // ── Render sidebar tree node ──
  const renderDocItem = (d: DocRef) => (
    <button
      key={d.id}
      onClick={() => loadDoc(d.id)}
      className={clsx(
        'w-full text-left px-3 py-1.5 rounded text-xs transition-colors flex items-center gap-2 truncate',
        selectedDocId === d.id
          ? 'bg-blue-500/10 text-blue-400'
          : 'text-gray-400 hover:bg-[#161616] hover:text-gray-200',
      )}
    >
      <span>{DOC_TYPE_ICONS[d.docType] ?? '\uD83D\uDCC4'}</span>
      <span className="truncate flex-1">{d.title}</span>
      <span className="text-[10px] text-gray-600 shrink-0">v{d.version}</span>
    </button>
  );

  const renderGroup = (key: string, label: string, icon: string, children: React.ReactNode, count: number) => (
    <div key={key}>
      <button
        onClick={() => toggleGroup(key)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-300 transition-colors"
      >
        <span className="text-[10px]">{expandedGroups.has(key) ? '\u25BC' : '\u25B6'}</span>
        <span>{icon}</span>
        <span className="flex-1 text-left">{label}</span>
        <span className="text-[10px] text-gray-600">{count}</span>
      </button>
      {expandedGroups.has(key) && <div className="ml-2 space-y-0.5">{children}</div>}
    </div>
  );

  const renderAssetNode = (node: DocTreeNode) => {
    const nodeKey = `asset-${node.id}`;
    const typeIcon = ASSET_TYPE_ICONS[node.type ?? ''] ?? '\uD83D\uDDA5\uFE0F';
    return (
      <div key={node.id}>
        <button
          onClick={() => toggleGroup(nodeKey)}
          className="w-full flex items-center gap-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-200 transition-colors"
        >
          <span className="text-[10px]">{expandedGroups.has(nodeKey) ? '\u25BC' : '\u25B6'}</span>
          <span>{typeIcon}</span>
          <span className="flex-1 text-left truncate">{node.name}</span>
          <span className="text-[10px] text-gray-600">{node.docs.length}</span>
        </button>
        {expandedGroups.has(nodeKey) && (
          <div className="ml-4 space-y-0.5">{node.docs.map(renderDocItem)}</div>
        )}
      </div>
    );
  };

  const renderServiceNode = (node: DocTreeNode) => {
    const nodeKey = `service-${node.id}`;
    return (
      <div key={node.id}>
        <button
          onClick={() => toggleGroup(nodeKey)}
          className="w-full flex items-center gap-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-200 transition-colors"
        >
          <span className="text-[10px]">{expandedGroups.has(nodeKey) ? '\u25BC' : '\u25B6'}</span>
          <span>{'\u2699\uFE0F'}</span>
          <span className="flex-1 text-left truncate">{node.name}</span>
          <span className="text-[10px] text-gray-600">{node.docs.length}</span>
        </button>
        {expandedGroups.has(nodeKey) && (
          <div className="ml-4 space-y-0.5">{node.docs.map(renderDocItem)}</div>
        )}
      </div>
    );
  };

  // ── Count total docs ──
  const totalDocs = useMemo(() => {
    if (!filteredTree) return 0;
    const assetDocs = (filteredTree.assets ?? []).reduce((sum, a) => sum + a.docs.length, 0);
    const serviceDocs = (filteredTree.services ?? []).reduce((sum, s) => sum + s.docs.length, 0);
    return assetDocs + serviceDocs + (filteredTree.unlinked?.length ?? 0);
  }, [filteredTree]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-0 bg-[#0a0a0a]">
        <button
          onClick={() => setActiveTab('browser')}
          className={clsx(
            'px-4 py-2 rounded-t-lg text-sm font-medium transition-colors',
            activeTab === 'browser'
              ? 'bg-[#111111] text-gray-200 border border-b-0 border-[#1f1f1f]'
              : 'text-gray-500 hover:text-gray-300',
          )}
        >
          Dokumente
        </button>
        <button
          onClick={() => setActiveTab('generator')}
          className={clsx(
            'px-4 py-2 rounded-t-lg text-sm font-medium transition-colors',
            activeTab === 'generator'
              ? 'bg-[#111111] text-gray-200 border border-b-0 border-[#1f1f1f]'
              : 'text-gray-500 hover:text-gray-300',
          )}
        >
          Generator
        </button>
      </div>

      {/* ══════════ Browser Tab ══════════ */}
      {activeTab === 'browser' && (
        <div className="flex flex-1 min-h-0 border-t border-[#1f1f1f]">
          {/* ── Tree Sidebar ── */}
          <aside className="w-64 shrink-0 border-r border-[#1f1f1f] bg-[#0a0a0a] flex flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#1f1f1f]">
              <span className="text-sm font-semibold text-gray-300 flex-1">Dokumente</span>
              <span className="text-[10px] text-gray-600">{totalDocs}</span>
              <button
                onClick={() => setShowCreate(true)}
                className="px-2 py-1 rounded text-xs font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                title="Neues Dokument erstellen"
              >
                + Neu
              </button>
              <button
                onClick={loadTree}
                disabled={treeLoading}
                className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300 hover:bg-[#1a1a1a] disabled:opacity-40 transition-colors"
                title="Aktualisieren"
              >
                {'\u21BB'}
              </button>
            </div>

            {/* Search */}
            <div className="px-3 py-2 border-b border-[#1f1f1f]">
              <input
                type="text"
                placeholder="Suchen..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-[#111111] border border-[#1f1f1f] text-sm text-gray-300 placeholder-gray-600 outline-none focus:border-[#333]"
              />
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {treeLoading && <Spinner label="Lade..." />}
              {treeError && (
                <div className="text-red-400 text-xs px-2 py-1">{treeError}</div>
              )}
              {filteredTree && !treeLoading && (
                <>
                  {(filteredTree.assets?.length ?? 0) > 0 &&
                    renderGroup(
                      'assets',
                      'Assets',
                      '\uD83D\uDDA5\uFE0F',
                      filteredTree.assets.map(renderAssetNode),
                      filteredTree.assets.reduce((s, a) => s + a.docs.length, 0),
                    )}
                  {(filteredTree.services?.length ?? 0) > 0 &&
                    renderGroup(
                      'services',
                      'Services',
                      '\u2699\uFE0F',
                      filteredTree.services.map(renderServiceNode),
                      filteredTree.services.reduce((s, a) => s + a.docs.length, 0),
                    )}
                  {(filteredTree.unlinked?.length ?? 0) > 0 &&
                    renderGroup(
                      'unlinked',
                      'Weitere',
                      '\uD83D\uDCC4',
                      filteredTree.unlinked.map(renderDocItem),
                      filteredTree.unlinked.length,
                    )}
                  {totalDocs === 0 && (
                    <div className="text-gray-600 text-xs text-center py-8">
                      {search ? 'Keine Treffer' : 'Keine Dokumente vorhanden'}
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>

          {/* ── Content Area ── */}
          <main className="flex-1 min-w-0 bg-[#0a0a0a] flex flex-col">
            {/* No doc selected */}
            {!selectedDocId && !showCreate && (
              <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                Dokument aus der Sidebar auswaehlen
              </div>
            )}

            {/* Loading doc */}
            {docLoading && <Spinner label="Lade Dokument..." />}

            {/* Doc error */}
            {docError && !docLoading && (
              <div className="p-6">
                <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-4 text-red-400 text-sm">
                  {docError}
                </div>
              </div>
            )}

            {/* Doc loaded */}
            {doc && !docLoading && (
              <>
                {/* Header */}
                <div className="flex items-center gap-3 px-6 py-3 border-b border-[#1f1f1f] flex-wrap">
                  <h1 className="text-gray-200 font-semibold text-sm flex-1 min-w-0 truncate">{doc.title}</h1>
                  <DocTypeBadge docType={doc.docType} />
                  <span className="text-[10px] text-gray-600">v{doc.version}</span>
                  <span className="text-[10px] text-gray-600">
                    {new Date(doc.createdAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </span>
                  {doc.linkedEntityType && (
                    <span className="text-[10px] text-gray-500">
                      {doc.linkedEntityType}{doc.linkedEntityId ? ` #${doc.linkedEntityId}` : ''}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => {
                        if (editing) {
                          setEditing(false);
                        } else {
                          setEditContent(doc.content);
                          setEditing(true);
                          setShowVersions(false);
                        }
                      }}
                      className={clsx(
                        'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                        editing
                          ? 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
                          : 'bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a]',
                      )}
                    >
                      {editing ? 'Abbrechen' : 'Bearbeiten'}
                    </button>
                    {editing && (
                      <button
                        onClick={handleSave}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                      >
                        Speichern
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setShowVersions(!showVersions);
                        if (!showVersions) loadVersions(doc.id);
                        setEditing(false);
                      }}
                      className={clsx(
                        'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                        showVersions
                          ? 'bg-purple-600/20 text-purple-400'
                          : 'bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a]',
                      )}
                    >
                      Versionen
                    </button>
                    {!confirmDelete ? (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                      >
                        Loeschen
                      </button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={handleDelete}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                        >
                          Bestaetigen
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="px-2 py-1.5 rounded text-xs text-gray-500 hover:text-gray-300 transition-colors"
                        >
                          Nein
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                  {/* Versions panel */}
                  {showVersions && (
                    <div className="border-b border-[#1f1f1f] bg-[#0d0d0d] px-6 py-3">
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Versionen</h3>
                      {versionsLoading ? (
                        <div className="text-gray-600 text-xs">Lade...</div>
                      ) : versions.length === 0 ? (
                        <div className="text-gray-600 text-xs">Keine Versionen verfuegbar</div>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {versions.map((v) => (
                            <button
                              key={`${v.id}-${v.version}`}
                              onClick={() => {
                                setDoc(v);
                                setShowVersions(false);
                              }}
                              className={clsx(
                                'w-full text-left px-3 py-1.5 rounded text-xs transition-colors flex items-center gap-3',
                                v.version === doc.version
                                  ? 'bg-blue-500/10 text-blue-400'
                                  : 'text-gray-400 hover:bg-[#161616] hover:text-gray-200',
                              )}
                            >
                              <span className="font-medium">v{v.version}</span>
                              <span className="text-gray-600">
                                {new Date(v.createdAt).toLocaleDateString('de-AT', {
                                  day: '2-digit', month: '2-digit', year: 'numeric',
                                  hour: '2-digit', minute: '2-digit',
                                })}
                              </span>
                              {v.generatedBy && <span className="text-gray-600">{v.generatedBy}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Editor mode */}
                  {editing ? (
                    <div className="flex flex-1 min-h-0 h-full">
                      <div className="w-1/2 border-r border-[#1f1f1f]">
                        <textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          className="w-full h-full min-h-[500px] bg-[#0a0a0a] text-gray-300 text-sm p-6 resize-none outline-none font-mono"
                          spellCheck={false}
                        />
                      </div>
                      <div className="w-1/2 overflow-y-auto p-6">
                        <div className="prose-dark">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {editContent}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-6 max-w-4xl">
                      <div className="bg-[#111111] border border-[#1f1f1f] rounded-lg p-6">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                          {doc.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Create Modal */}
            {showCreate && (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-2xl mx-auto bg-[#111111] border border-[#1f1f1f] rounded-xl p-6">
                  <h2 className="text-sm font-semibold text-gray-200 mb-4">Neues Dokument erstellen</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Titel *</label>
                      <input
                        type="text"
                        value={createTitle}
                        onChange={(e) => setCreateTitle(e.target.value)}
                        className="w-full px-3 py-2 rounded bg-[#0a0a0a] border border-[#1f1f1f] text-sm text-gray-300 outline-none focus:border-[#333]"
                        placeholder="Dokumenttitel..."
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Typ</label>
                      <select
                        value={createDocType}
                        onChange={(e) => setCreateDocType(e.target.value)}
                        className="w-full px-3 py-2 rounded bg-[#0a0a0a] border border-[#1f1f1f] text-sm text-gray-300 outline-none focus:border-[#333]"
                      >
                        {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">Entity-Typ (optional)</label>
                        <input
                          type="text"
                          value={createLinkedEntityType}
                          onChange={(e) => setCreateLinkedEntityType(e.target.value)}
                          className="w-full px-3 py-2 rounded bg-[#0a0a0a] border border-[#1f1f1f] text-sm text-gray-300 outline-none focus:border-[#333]"
                          placeholder="z.B. asset, service"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">Entity-ID (optional)</label>
                        <input
                          type="text"
                          value={createLinkedEntityId}
                          onChange={(e) => setCreateLinkedEntityId(e.target.value)}
                          className="w-full px-3 py-2 rounded bg-[#0a0a0a] border border-[#1f1f1f] text-sm text-gray-300 outline-none focus:border-[#333]"
                          placeholder="UUID"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Inhalt (Markdown)</label>
                      <textarea
                        value={createContent}
                        onChange={(e) => setCreateContent(e.target.value)}
                        rows={8}
                        className="w-full px-3 py-2 rounded bg-[#0a0a0a] border border-[#1f1f1f] text-sm text-gray-300 outline-none focus:border-[#333] font-mono resize-none"
                        placeholder="# Titel..."
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setShowCreate(false)}
                        className="px-4 py-2 rounded text-sm text-gray-400 hover:text-gray-300 transition-colors"
                      >
                        Abbrechen
                      </button>
                      <button
                        onClick={handleCreate}
                        disabled={!createTitle.trim() || createLoading}
                        className="px-4 py-2 rounded text-sm font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 disabled:opacity-40 transition-colors"
                      >
                        {createLoading ? 'Erstelle...' : 'Erstellen'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ══════════ Generator Tab ══════════ */}
      {activeTab === 'generator' && (
        <div className="flex flex-1 min-h-0 border-t border-[#1f1f1f]">
          {/* Sidebar */}
          <aside className="w-56 shrink-0 border-r border-[#1f1f1f] bg-[#0a0a0a] p-4 flex flex-col gap-1.5">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Generator
            </h2>
            {GENERATOR_TYPES.map((dt) => (
              <button
                key={dt.key}
                onClick={() => generate(dt.key)}
                className={clsx(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                  genType === dt.key
                    ? 'bg-[#1f1f1f] text-white'
                    : 'text-gray-400 hover:bg-[#161616] hover:text-gray-200',
                )}
              >
                <span className="text-base">{dt.icon}</span>
                {dt.label}
              </button>
            ))}
          </aside>

          {/* Content */}
          <main className="flex-1 min-w-0 bg-[#0a0a0a] flex flex-col">
            {genType && (
              <div className="flex items-center gap-3 px-6 py-3 border-b border-[#1f1f1f]">
                <h1 className="text-gray-200 font-semibold text-sm flex-1">
                  {GENERATOR_TYPES.find((d) => d.key === genType)?.label ?? genType}
                </h1>
                <button
                  onClick={() => generate(genType)}
                  disabled={genLoading}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
                >
                  Neu generieren
                </button>
                <button
                  onClick={handleCopy}
                  disabled={!genContent || genLoading}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
                >
                  {copied ? 'Kopiert!' : 'Copy Markdown'}
                </button>
                {genType === 'export' && exportData && (
                  <button
                    onClick={handleDownload}
                    className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                  >
                    Download JSON
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-6">
              {!genType && (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Dokument-Typ in der Seitenleiste auswaehlen.
                </div>
              )}
              {genLoading && <Spinner label="Generiere Dokumentation..." />}
              {genError && !genLoading && (
                <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-4 text-red-400 text-sm">
                  {genError}
                </div>
              )}
              {genContent && !genLoading && !genError && (
                <div className="bg-[#111111] border border-[#1f1f1f] rounded-lg p-6 max-w-4xl">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {genContent}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
