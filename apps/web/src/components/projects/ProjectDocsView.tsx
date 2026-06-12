'use client';

/**
 * v873 — Docs-Tab: Markdown-Dateien des Projekt-CWDs (Root-*.md + docs/**).
 *
 * Agents produzieren docs/*.md (Security-Reviews, Proposals, Audits) — bisher
 * nur per Repo-Zugriff lesbar. Lesen ist serverseitig traversal-sicher
 * (nur .md, Pfad muss im cwd bleiben).
 */
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AlfredClient, ProjectDocFile } from '@/lib/alfred-client';

const mdComponents = {
  h1: ({ children, ...props }: any) => <h1 className="text-lg font-bold text-white mt-4 mb-2" {...props}>{children}</h1>,
  h2: ({ children, ...props }: any) => <h2 className="text-base font-bold text-gray-100 mt-4 mb-2 border-b border-[#1f1f1f] pb-1" {...props}>{children}</h2>,
  h3: ({ children, ...props }: any) => <h3 className="text-sm font-semibold text-gray-200 mt-3 mb-1" {...props}>{children}</h3>,
  h4: ({ children, ...props }: any) => <h4 className="text-xs font-semibold text-gray-300 mt-3 mb-1" {...props}>{children}</h4>,
  p: ({ children, ...props }: any) => <p className="text-gray-300 text-xs leading-relaxed mb-2" {...props}>{children}</p>,
  ul: ({ children, ...props }: any) => <ul className="ml-4 list-disc text-gray-300 text-xs space-y-0.5 mb-2" {...props}>{children}</ul>,
  ol: ({ children, ...props }: any) => <ol className="ml-4 list-decimal text-gray-300 text-xs space-y-0.5 mb-2" {...props}>{children}</ol>,
  li: ({ children, ...props }: any) => <li className="text-gray-300" {...props}>{children}</li>,
  strong: ({ children, ...props }: any) => <strong className="text-white font-semibold" {...props}>{children}</strong>,
  a: ({ children, href, ...props }: any) => <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>,
  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    if (isInline) return <code className="bg-[#1a1a1a] text-green-400 px-1 py-0.5 rounded text-[11px]" {...props}>{children}</code>;
    return <code className="text-green-400 text-[11px]" {...props}>{children}</code>;
  },
  pre: ({ children, ...props }: any) => (
    <pre className="bg-[#0d0d0d] border border-[#2a2a2a] rounded p-3 overflow-x-auto text-[11px] leading-relaxed my-2" {...props}>{children}</pre>
  ),
  table: ({ children, ...props }: any) => <table className="text-xs border-collapse my-2" {...props}>{children}</table>,
  th: ({ children, ...props }: any) => <th className="border border-[#2a2a2a] px-2 py-1 text-left text-gray-200 bg-[#1a1a1a]" {...props}>{children}</th>,
  td: ({ children, ...props }: any) => <td className="border border-[#2a2a2a] px-2 py-1 text-gray-300" {...props}>{children}</td>,
  blockquote: ({ children, ...props }: any) => <blockquote className="border-l-2 border-[#333] pl-3 text-gray-400 my-2" {...props}>{children}</blockquote>,
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectDocsView({ client, projectId }: { client: AlfredClient; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<ProjectDocFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    const r = await client.fetchProjectDocs(projectId);
    setFiles(r.files);
    setListError(r.error ?? null);
  }, [client, projectId]);

  useEffect(() => {
    // Projekt-Wechsel: Zustand zurücksetzen
    setFiles(null); setSelected(null); setContent(null); setListError(null); setExpanded(false);
  }, [projectId]);

  useEffect(() => {
    if (expanded && files === null) void loadList();
  }, [expanded, files, loadList]);

  async function open(path: string) {
    setSelected(path);
    setContent(null);
    setLoading(true);
    try {
      const r = await client.fetchProjectDocContent(projectId, path);
      if (r.error) {
        setContent(`*Fehler beim Laden:* ${r.error}`);
        setTruncated(false);
      } else {
        setContent(r.content ?? '');
        setTruncated(r.truncated ?? false);
      }
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5">
          <span>📄</span>
          <span>Doku anzeigen (Markdown im Repo)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>📄</span>
          <span>Doku{files ? ` (${files.length})` : ''}</span>
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={() => void loadList()} className="text-[10px] text-cyan-400 hover:underline">aktualisieren</button>
          <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
        </div>
      </div>

      {listError && <div className="text-xs text-red-400 mb-2">✗ {listError}</div>}
      {files === null && !listError && <div className="text-xs text-gray-600">Lade Dateiliste…</div>}
      {files !== null && files.length === 0 && <div className="text-xs text-gray-600">Keine Markdown-Dateien gefunden (Root + docs/).</div>}

      {files !== null && files.length > 0 && (
        <div className="flex gap-3">
          {/* Dateiliste */}
          <div className="w-56 shrink-0 space-y-0.5 max-h-96 overflow-y-auto">
            {files.map(f => (
              <button
                key={f.path}
                onClick={() => void open(f.path)}
                className={`block w-full text-left px-2 py-1 rounded text-[11px] truncate ${selected === f.path ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-200'}`}
                title={`${f.path} · ${fmtSize(f.sizeBytes)} · ${new Date(f.modifiedAt).toLocaleString('de-AT')}`}
              >
                {f.path}
              </button>
            ))}
          </div>

          {/* Inhalt */}
          <div className="flex-1 min-w-0 bg-[#0d0d0d] border border-[#1f1f1f] rounded p-3 max-h-96 overflow-y-auto">
            {!selected && <div className="text-xs text-gray-600 italic">Datei links auswählen.</div>}
            {selected && loading && <div className="text-xs text-gray-600">Lade {selected}…</div>}
            {selected && !loading && content !== null && (
              <>
                {truncated && <div className="text-[10px] text-amber-400 mb-2">⚠ Datei größer als 1 MB — gekürzt dargestellt.</div>}
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
