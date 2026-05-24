'use client';

import { useState, useRef, useLayoutEffect, type KeyboardEvent } from 'react';
import { useConfig } from '@/context/ConfigContext';
import { ItemMentionPicker, type MentionedItem } from './ItemMentionPicker';

export interface SandboxChatAttachment {
  name: string;
  mime: string;
  dataUrl: string;
  /** v729a — User-Wahl: in /workspace/.alfred-uploads/ im Sandbox-Worktree ablegen? */
  dropInWorktree: boolean;
}

export type SandboxChatEngine = 'project-agent' | 'code-agent';

interface SandboxChatInputProps {
  onSend: (text: string, attachments?: SandboxChatAttachment[], mentions?: MentionedItem[], engine?: SandboxChatEngine) => void;
  disabled?: boolean;
  placeholder?: string;
  /** v730 — Project-ID damit der Mention-Picker Open-Items/Decisions des Projekts laden kann */
  projectId?: string;
  /** v761 — Engine-Toggle (⚡Quick = code-agent, 🚀Plan = project-agent). State von parent gehalten (für localStorage-Persist pro Sandbox). */
  engine?: SandboxChatEngine;
  onEngineChange?: (engine: SandboxChatEngine) => void;
}

interface PendingAttachment {
  name: string;
  mime: string;
  dataUrl: string;
  sizeKB: number;
  dropInWorktree: boolean;
}

const MAX_ROWS = 8;
const MAX_FILE_MB = 10;
const MAX_ATTACHMENTS = 5;

export function SandboxChatInput({ onSend, disabled, placeholder, projectId, engine, onEngineChange }: SandboxChatInputProps) {
  const { client } = useConfig();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // v730 — Item-Mentions
  const [mentions, setMentions] = useState<MentionedItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function fileToAttachment(file: File): Promise<PendingAttachment | null> {
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`Datei zu groß (${(file.size / 1024 / 1024).toFixed(1)} MB > ${MAX_FILE_MB} MB).`);
      return null;
    }
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    // Default: Code-relevante Files (md/txt/json/yaml/csv/code) werden eher im Worktree gewünscht,
    // Bilder/PDFs eher als LLM-Context. Heuristik:
    const isCodeOrText = /^(text\/|application\/(json|yaml|x-yaml))/i.test(file.type) || /\.(md|txt|json|ya?ml|csv|env)$/i.test(file.name);
    return {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      dataUrl,
      sizeKB: Math.round(file.size / 1024),
      dropInWorktree: isCodeOrText,
    };
  }

  async function addFiles(files: FileList | File[]) {
    const additions: PendingAttachment[] = [];
    for (const f of Array.from(files)) {
      const a = await fileToAttachment(f);
      if (a) additions.push(a);
    }
    setAttachments(prev => [...prev, ...additions].slice(0, MAX_ATTACHMENTS));
  }

  function onDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragOver(true); }
  function onDragLeave() { setIsDragOver(false); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }
  async function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const f = items[i].getAsFile();
      if (f) files.push(f);
    }
    if (files.length > 0) { e.preventDefault(); await addFiles(files); }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) { alert('Mikrofon nicht verfügbar.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1000) { setIsRecording(false); return; }
        setTranscribing(true);
        try {
          const transcript = await client.transcribeAudio(blob);
          if (transcript) {
            setText(prev => prev ? prev + ' ' + transcript : transcript);
            textareaRef.current?.focus();
          } else {
            alert('Transkription leer.');
          }
        } catch (err) {
          alert('Transkription fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
          setTranscribing(false);
          setIsRecording(false);
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
    } catch (err) {
      alert('Mikrofon-Zugriff verweigert oder fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [text]);

  function handleSend() {
    if (disabled) return;
    if (!text.trim() && attachments.length === 0 && mentions.length === 0) return;
    onSend(
      text.trim(),
      attachments.length > 0
        ? attachments.map(a => ({ name: a.name, mime: a.mime, dataUrl: a.dataUrl, dropInWorktree: a.dropInWorktree }))
        : undefined,
      mentions.length > 0 ? mentions : undefined,
      engine,
    );
    setText('');
    setAttachments([]);
    setMentions([]);
    textareaRef.current?.focus();
  }

  function pickMention(item: MentionedItem) {
    setMentions(prev => prev.some(m => m.id === item.id) ? prev : [...prev, item]);
    // Picker NICHT zu — User kann weitere wählen. Per X schließt er.
  }
  function removeMention(id: string) {
    setMentions(prev => prev.filter(m => m.id !== id));
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !(e as any).isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  function toggleWorktreeDrop(idx: number) {
    setAttachments(prev => prev.map((a, i) => i === idx ? { ...a, dropInWorktree: !a.dropInWorktree } : a));
  }

  function removeAttachment(idx: number) {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }

  return (
    <div
      className={`relative border-t border-[#1a1a1a] p-2 ${isDragOver ? 'bg-purple-500/10 ring-2 ring-purple-500/40' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* v730 — Mentioned-Items als Chips */}
      {mentions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {mentions.map(m => (
            <span key={m.id} className="inline-flex items-center gap-1 text-[11px] bg-blue-500/15 border border-blue-500/40 text-blue-200 rounded px-2 py-0.5">
              <span>{m.type === 'open_item' ? (m.priority === 'high' ? '🔴' : m.priority === 'low' ? '⚪' : '🟡') : '🎯'}</span>
              <span className="font-mono text-[10px] text-blue-300/70">{m.id.slice(0, 8)}</span>
              <span className="truncate max-w-[280px]" title={m.title}>{m.title}</span>
              <button onClick={() => removeMention(m.id)} className="text-blue-300/70 hover:text-blue-200 ml-1" title="Entfernen">✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-2 space-y-1">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] bg-[#0f0f0f] border border-[#1f1f1f] rounded px-2 py-1">
              <span className="text-amber-300">📎</span>
              <span className="text-gray-300 flex-1 truncate" title={a.name}>{a.name}</span>
              <span className="text-gray-500">{a.sizeKB} KB</span>
              <label className="flex items-center gap-1 text-gray-400 cursor-pointer" title="In Sandbox-Worktree unter .alfred-uploads/ ablegen damit Agent darauf zugreifen kann">
                <input
                  type="checkbox"
                  checked={a.dropInWorktree}
                  onChange={() => toggleWorktreeDrop(i)}
                  className="cursor-pointer"
                />
                <span>📁 Worktree</span>
              </label>
              <button onClick={() => removeAttachment(i)} className="text-red-400 hover:text-red-300" title="Entfernen">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            title={attachments.length >= MAX_ATTACHMENTS ? `Max ${MAX_ATTACHMENTS} Dateien` : 'Datei anhängen'}
            className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded text-xs disabled:opacity-40"
          >
            📎
          </button>
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={disabled || transcribing}
            title={isRecording ? 'Aufnahme stoppen' : transcribing ? 'Transkribiere…' : 'Sprachaufnahme starten'}
            className={`px-2 py-1 border rounded text-xs disabled:opacity-40 ${isRecording ? 'border-red-500/60 text-red-400 bg-red-500/10 animate-pulse' : transcribing ? 'border-amber-500/60 text-amber-400' : 'border-gray-500/40 text-gray-300 hover:bg-gray-500/15'}`}
          >
            {transcribing ? '⏳' : isRecording ? '⏺' : '🎤'}
          </button>
          {projectId && (
            <button
              onClick={() => setPickerOpen(true)}
              disabled={disabled}
              title="Open-Items / Decisions referenzieren"
              className="px-2 py-1 border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 rounded text-xs disabled:opacity-40"
            >
              📋
            </button>
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          placeholder={placeholder ?? 'Was soll der Agent ändern? (Enter = senden, Shift+Enter = Zeilenumbruch)'}
          className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-3 py-2 text-sm text-gray-200 resize-none focus:outline-none focus:border-purple-500/40 disabled:opacity-50"
          rows={1}
        />

        {/* v761 — Engine-Toggle: ⚡Quick (code-agent, iterativ) vs 🚀Plan (project-agent, 14-Phasen) */}
        {onEngineChange && (
          <div className="flex flex-col gap-0 border border-[#2a2a2a] rounded overflow-hidden text-[10px]">
            <button
              onClick={() => onEngineChange('code-agent')}
              disabled={disabled}
              title="Iterativ: Eine fokussierte Änderung pro Nachricht, Auto-Commit, ~1-3min"
              className={`px-2 py-1 ${engine === 'code-agent' ? 'bg-purple-600 text-white' : 'bg-[#0a0a0a] text-gray-400 hover:bg-purple-500/10 hover:text-purple-300'}`}
            >⚡ Quick</button>
            <button
              onClick={() => onEngineChange('project-agent')}
              disabled={disabled}
              title="Plan-basiert: 14-Phasen-Planner mit Tests/Fixes, 15-60min, für große Features"
              className={`px-2 py-1 ${engine === 'project-agent' ? 'bg-emerald-600 text-white' : 'bg-[#0a0a0a] text-gray-400 hover:bg-emerald-500/10 hover:text-emerald-300'}`}
            >🚀 Plan</button>
          </div>
        )}

        <button
          onClick={handleSend}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
        >
          Senden
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.txt,.json,.yaml,.yml,.csv,.env,.png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,text/*,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
          className="hidden"
        />
      </div>

      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-purple-500/30 text-purple-100 px-4 py-2 rounded text-sm">Dateien hier loslassen…</div>
        </div>
      )}

      {pickerOpen && projectId && (
        <ItemMentionPicker
          projectId={projectId}
          selectedIds={mentions.map(m => m.id)}
          onPick={pickMention}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
