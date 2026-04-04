'use client';

import { useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';

// ── Types ──

interface DocType {
  key: string;
  label: string;
  icon: string;
}

interface ArchivedDoc {
  id: string;
  docType: string;
  title: string;
  version: number;
  createdAt: string;
  content: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
}

const DOC_TYPES: DocType[] = [
  { key: 'inventory_report', label: 'Inventar', icon: '\uD83D\uDCE6' },
  { key: 'topology_diagram', label: 'Topologie', icon: '\uD83D\uDD17' },
  { key: 'service_map', label: 'Services', icon: '\u2699\uFE0F' },
  { key: 'change_log', label: 'Changes', icon: '\uD83D\uDCDD' },
  { key: 'export', label: 'Export', icon: '\uD83D\uDCE5' },
  { key: 'archive', label: 'Archiv', icon: '\uD83D\uDCDA' },
];

const DOC_TYPE_LABELS: Record<string, string> = {
  inventory_report: 'Inventar',
  topology_diagram: 'Topologie',
  service_map: 'Services',
  change_log: 'Changes',
};

// ── Helpers ──

function formatMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <div key={nodes.length} className="my-3">
          {lang && (
            <div className="text-[10px] uppercase tracking-wider text-gray-500 bg-[#1a1a1a] px-3 py-1 rounded-t border border-b-0 border-[#2a2a2a] inline-block">
              {lang}
            </div>
          )}
          <pre className="bg-[#0d0d0d] border border-[#2a2a2a] rounded-b rounded-tr p-4 overflow-x-auto text-sm text-green-400 leading-relaxed">
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      nodes.push(<h3 key={nodes.length} className="text-base font-semibold text-gray-200 mt-5 mb-2">{line.slice(4)}</h3>);
    } else if (line.startsWith('## ')) {
      nodes.push(<h2 key={nodes.length} className="text-lg font-bold text-gray-100 mt-6 mb-2 border-b border-[#1f1f1f] pb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith('# ')) {
      nodes.push(<h1 key={nodes.length} className="text-xl font-bold text-white mt-6 mb-3">{line.slice(2)}</h1>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      nodes.push(<li key={nodes.length} className="ml-4 text-gray-300 list-disc">{line.slice(2)}</li>);
    } else if (line.startsWith('| ')) {
      // Table rows — collect all contiguous pipe rows
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('| ')) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines
        .filter((r) => !r.match(/^\|\s*[-:]+/)) // skip separator rows
        .map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));

      nodes.push(
        <div key={nodes.length} className="overflow-x-auto my-3">
          <table className="text-sm w-full border-collapse">
            {rows.length > 0 && (
              <thead>
                <tr>
                  {rows[0].map((cell, ci) => (
                    <th key={ci} className="text-left px-3 py-1.5 text-gray-400 border-b border-[#2a2a2a] font-medium">{cell}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.slice(1).map((row, ri) => (
                <tr key={ri} className="hover:bg-[#1a1a1a]">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-gray-300 border-b border-[#161616]">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    } else if (line.trim() === '') {
      nodes.push(<div key={nodes.length} className="h-2" />);
    } else {
      // Inline bold
      const parts = line.split(/\*\*(.*?)\*\*/g);
      const inlined = parts.map((p, pi) =>
        pi % 2 === 1 ? <strong key={pi} className="text-white font-semibold">{p}</strong> : p,
      );
      nodes.push(<p key={nodes.length} className="text-gray-300 leading-relaxed">{inlined}</p>);
    }
    i++;
  }
  return nodes;
}

// ── Component ──

export function InfraDocsPage() {
  const { client } = useConfig();
  const [activeType, setActiveType] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportData, setExportData] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedConfirm, setSavedConfirm] = useState(false);

  // Archive state
  const [archiveDocs, setArchiveDocs] = useState<ArchivedDoc[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [selectedArchiveDoc, setSelectedArchiveDoc] = useState<ArchivedDoc | null>(null);

  const loadArchive = useCallback(async () => {
    setArchiveLoading(true);
    setError(null);
    try {
      const docs = await client.cmdbListDocuments();
      setArchiveDocs(docs ?? []);
    } catch (err: any) {
      setError(err.message ?? 'Archiv konnte nicht geladen werden');
    } finally {
      setArchiveLoading(false);
    }
  }, [client]);

  const loadArchiveDoc = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const doc = await client.cmdbGetDocument(id);
      setSelectedArchiveDoc(doc);
      setContent(doc.content ?? '');
    } catch (err: any) {
      setError(err.message ?? 'Dokument konnte nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [client]);

  const showSavedConfirm = useCallback(() => {
    setSavedConfirm(true);
    setTimeout(() => setSavedConfirm(false), 2000);
  }, []);

  const generate = useCallback(
    async (type: string) => {
      if (type === 'archive') {
        setActiveType('archive');
        setContent('');
        setError(null);
        setExportData(null);
        setSelectedArchiveDoc(null);
        loadArchive();
        return;
      }

      setActiveType(type);
      setContent('');
      setError(null);
      setExportData(null);
      setSelectedArchiveDoc(null);
      setLoading(true);

      try {
        if (type === 'export') {
          const res = await client.docsExport('json');
          if (!res.success) throw new Error(res.display ?? 'Export fehlgeschlagen');
          setExportData(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
          setContent(res.display ?? 'Export bereit.');
        } else {
          const res = await client.docsGenerate(type);
          if (!res.success) throw new Error(res.display ?? 'Generierung fehlgeschlagen');
          setContent(res.display ?? '');
          showSavedConfirm();
        }
      } catch (err: any) {
        setError(err.message ?? 'Unbekannter Fehler');
      } finally {
        setLoading(false);
      }
    },
    [client, loadArchive, showSavedConfirm],
  );

  const handleCopy = useCallback(async () => {
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

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

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ── */}
      <aside className="w-56 shrink-0 border-r border-[#1f1f1f] bg-[#0a0a0a] p-4 flex flex-col gap-1.5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Infra Docs
        </h2>
        {DOC_TYPES.map((dt) => (
          <button
            key={dt.key}
            onClick={() => generate(dt.key)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
              activeType === dt.key
                ? 'bg-[#1f1f1f] text-white'
                : 'text-gray-400 hover:bg-[#161616] hover:text-gray-200'
            }`}
          >
            <span className="text-base">{dt.icon}</span>
            {dt.label}
          </button>
        ))}
      </aside>

      {/* ── Content ── */}
      <main className="flex-1 min-w-0 bg-[#0a0a0a] flex flex-col">
        {/* Toolbar */}
        {activeType && (
          <div className="flex items-center gap-3 px-6 py-3 border-b border-[#1f1f1f]">
            <h1 className="text-gray-200 font-semibold text-sm flex-1">
              {selectedArchiveDoc
                ? selectedArchiveDoc.title
                : (DOC_TYPES.find((d) => d.key === activeType)?.label ?? activeType)}
            </h1>
            {savedConfirm && (
              <span className="text-xs text-green-400 animate-pulse transition-opacity">
                Gespeichert
              </span>
            )}
            {activeType === 'archive' && selectedArchiveDoc && (
              <button
                onClick={() => { setSelectedArchiveDoc(null); setContent(''); }}
                className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] transition-colors"
              >
                Zurueck zur Liste
              </button>
            )}
            {activeType === 'archive' && !selectedArchiveDoc && (
              <button
                onClick={() => loadArchive()}
                disabled={archiveLoading}
                className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
              >
                Aktualisieren
              </button>
            )}
            {activeType !== 'archive' && (
              <>
                <button
                  onClick={() => generate(activeType)}
                  disabled={loading}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
                >
                  Neu generieren
                </button>
                <button
                  onClick={handleCopy}
                  disabled={!content || loading}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[#1f1f1f] text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
                >
                  {copied ? 'Kopiert!' : 'Copy Markdown'}
                </button>
              </>
            )}
            {activeType === 'export' && exportData && (
              <button
                onClick={handleDownload}
                className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
              >
                Download JSON
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {!activeType && (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              Dokument-Typ in der Seitenleiste auswaehlen.
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <svg className="animate-spin h-8 w-8 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-gray-500 text-sm">
                  {activeType === 'archive' ? 'Lade Dokument...' : 'Generiere Dokumentation...'}
                </span>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-4 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Archive table view */}
          {activeType === 'archive' && !selectedArchiveDoc && !loading && !error && (
            <div className="max-w-5xl">
              {archiveLoading ? (
                <div className="flex items-center justify-center py-12">
                  <svg className="animate-spin h-8 w-8 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : archiveDocs.length === 0 ? (
                <div className="text-gray-600 text-sm text-center py-12">
                  Keine archivierten Dokumente vorhanden.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left px-4 py-2.5 text-gray-400 border-b border-[#2a2a2a] font-medium">Typ</th>
                        <th className="text-left px-4 py-2.5 text-gray-400 border-b border-[#2a2a2a] font-medium">Titel</th>
                        <th className="text-left px-4 py-2.5 text-gray-400 border-b border-[#2a2a2a] font-medium">Entity</th>
                        <th className="text-left px-4 py-2.5 text-gray-400 border-b border-[#2a2a2a] font-medium">Version</th>
                        <th className="text-left px-4 py-2.5 text-gray-400 border-b border-[#2a2a2a] font-medium">Datum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archiveDocs.map((doc) => (
                        <tr
                          key={doc.id}
                          onClick={() => loadArchiveDoc(doc.id)}
                          className="hover:bg-[#1a1a1a] cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-2.5 text-gray-300 border-b border-[#161616]">
                            <span className="inline-block px-2 py-0.5 rounded text-xs bg-[#1f1f1f] text-gray-400">
                              {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-200 border-b border-[#161616] font-medium">
                            {doc.title}
                          </td>
                          <td className="px-4 py-2.5 text-gray-400 border-b border-[#161616]">
                            {doc.linkedEntityType
                              ? `${doc.linkedEntityType}${doc.linkedEntityId ? ` #${doc.linkedEntityId}` : ''}`
                              : '\u2014'}
                          </td>
                          <td className="px-4 py-2.5 text-gray-400 border-b border-[#161616]">
                            v{doc.version}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 border-b border-[#161616]">
                            {new Date(doc.createdAt).toLocaleDateString('de-AT', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Document content (both generated and archive detail) */}
          {content && !loading && !error && (activeType !== 'archive' || selectedArchiveDoc) && (
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-lg p-6 max-w-4xl">
              {formatMarkdown(content)}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
