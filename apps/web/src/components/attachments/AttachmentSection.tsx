'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { AttachmentItem } from '@/lib/alfred-client';

interface Props {
  entityType: 'todo' | 'note';
  entityId: string;
}

const KIND_ICON: Record<string, string> = {
  document: '📄',
  file: '📁',
  url: '🔗',
  upload: '⬆',
};

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * v673 — Wiederverwendbare Attachment-Section für Todos & Notes.
 * Zeigt vorhandene Anhänge + Add-Button öffnet Modal mit 4 Tabs:
 *   📄 Documents  — RAG-indizierte PDFs/Docs aus documents-Tabelle
 *   📁 Files      — bereits im FileStore vorhandene Files (frühere Uploads)
 *   🔗 URL        — Text-Input für externen Link
 *   ⬆ Upload     — Direct-Upload (Base64, max 25 MB)
 */
export function AttachmentSection({ entityType, entityId }: Props) {
  const { client } = useConfig();
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(async () => {
    if (!client || !entityId) return;
    setLoading(true);
    try {
      const list = await client.fetchAttachments(entityType, entityId);
      setItems(list);
    } finally { setLoading(false); }
  }, [client, entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  async function remove(id: string) {
    if (!client) return;
    if (!confirm('Anhang wirklich entfernen?')) return;
    const ok = await client.deleteAttachment(id);
    if (ok) setItems(prev => prev.filter(a => a.id !== id));
  }

  function attachmentUrl(att: AttachmentItem): string | null {
    if (att.sourceKind === 'url') return att.sourceRef;
    // Document → eigentliche Anzeige nur via Skill — wir öffnen die Docs-Seite
    if (att.sourceKind === 'document') return `/docs?doc=${encodeURIComponent(att.sourceRef)}`;
    // File / Upload → kein direkter Download-Endpoint in dieser Phase (kommt v674)
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold flex items-center justify-between">
        <span>📎 Anhänge ({items.length})</span>
        <button onClick={() => setShowPicker(true)} className="text-blue-400 hover:text-blue-300 text-[10px]">+ Anhang hinzufügen</button>
      </div>
      {loading && <div className="text-[11px] text-gray-500 italic">Lade …</div>}
      {!loading && items.length === 0 && (
        <div className="text-[11px] text-gray-600 italic">
          Keine Anhänge. Verknüpfe ein Document, eine bereits hochgeladene Datei, eine URL oder lade direkt eine neue Datei hoch.
        </div>
      )}
      <div className="space-y-1">
        {items.map(a => {
          const url = attachmentUrl(a);
          const display = a.label ?? a.sourceRef;
          const inner = (
            <>
              <span className="text-base shrink-0">{KIND_ICON[a.sourceKind] ?? '📎'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-200 truncate">{display}</div>
                <div className="text-[10px] text-gray-600 flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono">{a.sourceKind}</span>
                  {a.mimeType && <span>· {a.mimeType}</span>}
                  {a.sizeBytes != null && <span>· {formatSize(a.sizeBytes)}</span>}
                </div>
              </div>
            </>
          );
          return (
            <div key={a.id} className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1.5">
              {url ? (
                <a href={url} target={a.sourceKind === 'url' ? '_blank' : undefined} rel="noopener noreferrer" className="flex items-center gap-2 flex-1 min-w-0 hover:bg-[#141414] -mx-1 px-1 py-0.5 rounded">
                  {inner}
                </a>
              ) : (
                <div className="flex items-center gap-2 flex-1 min-w-0">{inner}</div>
              )}
              <button onClick={() => remove(a.id)} className="text-gray-600 hover:text-red-400 text-[10px] shrink-0" title="Anhang entfernen">✕</button>
            </div>
          );
        })}
      </div>
      {showPicker && (
        <AttachmentPickerModal
          entityType={entityType}
          entityId={entityId}
          onClose={() => setShowPicker(false)}
          onAdded={(att) => { setItems(prev => [att, ...prev]); setShowPicker(false); }}
        />
      )}
    </div>
  );
}

type Tab = 'documents' | 'files' | 'url' | 'upload';

function AttachmentPickerModal({ entityType, entityId, onClose, onAdded }: {
  entityType: 'todo' | 'note';
  entityId: string;
  onClose: () => void;
  onAdded: (a: AttachmentItem) => void;
}) {
  const { client } = useConfig();
  const [tab, setTab] = useState<Tab>('documents');
  const [docs, setDocs] = useState<Array<{ id: string; filename: string; mimeType?: string; sizeBytes?: number }>>([]);
  const [files, setFiles] = useState<Array<{ key: string; fileName: string; size: number }>>([]);
  const [search, setSearch] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [urlLabel, setUrlLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-Load pro Tab
  useEffect(() => {
    if (!client) return;
    if (tab === 'documents' && docs.length === 0) {
      client.fetchAvailableDocuments().then(setDocs).catch(() => setError('Documents konnten nicht geladen werden'));
    } else if (tab === 'files' && files.length === 0) {
      client.fetchStoredFiles().then(setFiles).catch(() => setError('Files konnten nicht geladen werden'));
    }
  }, [client, tab, docs.length, files.length]);

  async function pickDocument(d: { id: string; filename: string; mimeType?: string; sizeBytes?: number }) {
    if (!client) return;
    const att = await client.addAttachment(entityType, entityId, {
      sourceKind: 'document', sourceRef: d.id, label: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes,
    });
    if (att) onAdded(att);
    else setError('Anhang konnte nicht angelegt werden');
  }
  async function pickFile(f: { key: string; fileName: string; size: number }) {
    if (!client) return;
    const att = await client.addAttachment(entityType, entityId, {
      sourceKind: 'file', sourceRef: f.key, label: f.fileName, sizeBytes: f.size,
    });
    if (att) onAdded(att);
    else setError('Anhang konnte nicht angelegt werden');
  }
  async function addUrl() {
    if (!client || !urlInput.trim()) return;
    if (!/^https?:\/\//i.test(urlInput.trim())) {
      setError('URL muss mit http:// oder https:// starten');
      return;
    }
    const att = await client.addAttachment(entityType, entityId, {
      sourceKind: 'url', sourceRef: urlInput.trim(), label: urlLabel.trim() || undefined,
    });
    if (att) onAdded(att);
    else setError('URL konnte nicht hinzugefügt werden');
  }
  async function handleUpload(file: File) {
    if (!client) return;
    if (file.size > 25 * 1024 * 1024) {
      setError('Datei zu groß (max 25 MB).');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const base64Data = await fileToBase64(file);
      const uploaded = await client.uploadFileBase64(file.name, file.type || 'application/octet-stream', base64Data);
      if (!uploaded) { setError('Upload fehlgeschlagen (FileStore nicht aktiv?)'); return; }
      const att = await client.addAttachment(entityType, entityId, {
        sourceKind: 'upload', sourceRef: uploaded.key, label: uploaded.fileName,
        mimeType: uploaded.mimeType, sizeBytes: uploaded.size,
      });
      if (att) onAdded(att);
      else setError('Anhang nach Upload konnte nicht angelegt werden');
    } finally { setUploading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-4 max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-gray-100">📎 Anhang hinzufügen</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-red-400">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[#1f1f1f] mb-3">
          {([
            { key: 'documents', label: '📄 Documents' },
            { key: 'files', label: '📁 Frühere Uploads' },
            { key: 'url', label: '🔗 URL' },
            { key: 'upload', label: '⬆ Neuer Upload' },
          ] as const).map(t => (
            <button key={t.key} onClick={() => { setTab(t.key); setError(null); }} className={`px-3 py-1.5 text-xs border-b-2 transition-colors ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}>{t.label}</button>
          ))}
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded px-2 py-1 text-xs mb-2">{error}</div>}

        <div className="flex-1 overflow-y-auto">
          {tab === 'documents' && (
            <div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Document suchen (Dateiname)…"
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mb-2"
              />
              {docs.length === 0 && <div className="text-[11px] text-gray-600 italic p-2">Keine Documents verfügbar. Lade welche unter /docs hoch.</div>}
              <div className="space-y-1">
                {docs.filter(d => search === '' || d.filename.toLowerCase().includes(search.toLowerCase())).slice(0, 50).map(d => (
                  <button key={d.id} onClick={() => pickDocument(d)} className="w-full text-left bg-[#0d0d0d] hover:bg-blue-500/10 border border-[#2a2a2a] hover:border-blue-500/40 rounded px-2 py-1.5 text-xs">
                    <div className="font-medium text-gray-200 truncate">📄 {d.filename}</div>
                    <div className="text-[10px] text-gray-500">{d.mimeType ?? '—'}{d.sizeBytes ? ` · ${formatSize(d.sizeBytes)}` : ''}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab === 'files' && (
            <div>
              {files.length === 0 && <div className="text-[11px] text-gray-600 italic p-2">Keine gespeicherten Files. Lade eine neue Datei unter „Neuer Upload" hoch.</div>}
              <div className="space-y-1">
                {files.map(f => (
                  <button key={f.key} onClick={() => pickFile(f)} className="w-full text-left bg-[#0d0d0d] hover:bg-blue-500/10 border border-[#2a2a2a] hover:border-blue-500/40 rounded px-2 py-1.5 text-xs">
                    <div className="font-medium text-gray-200 truncate">📁 {f.fileName}</div>
                    <div className="text-[10px] text-gray-500 font-mono truncate">{f.key} · {formatSize(f.size)}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab === 'url' && (
            <div className="space-y-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">URL</label>
                <input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://…"
                  className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Anzeige-Name (optional)</label>
                <input
                  value={urlLabel}
                  onChange={(e) => setUrlLabel(e.target.value)}
                  placeholder="z.B. „API-Doku Foo"
                  className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
                />
              </div>
              <button onClick={addUrl} disabled={!urlInput.trim()} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs font-semibold">URL anhängen</button>
            </div>
          )}
          {tab === 'upload' && (
            <div className="space-y-2">
              <div className="text-[11px] text-gray-500">Lade eine Datei direkt hoch (max 25 MB). Sie wird im FileStore gespeichert und kann später aus „Frühere Uploads" wiederverwendet werden.</div>
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
                disabled={uploading}
                className="text-xs text-gray-300"
              />
              {uploading && <div className="text-[11px] text-blue-300 italic animate-pulse">⏳ Lade hoch …</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { reject(new Error('FileReader returned non-string')); return; }
      // result is "data:<mime>;base64,<data>" — wir wollen nur den base64-Teil
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
