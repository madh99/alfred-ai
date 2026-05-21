'use client';

import { useState, useRef, useEffect, useLayoutEffect, useMemo, type KeyboardEvent } from 'react';
import { SlashCommandPalette, type SlashCommand } from './SlashCommandPalette';
import { useConfig } from '@/context/ConfigContext';

interface InputBarProps {
  onSend: (text: string, attachments?: Array<{ name: string; mime: string; dataUrl: string }>) => void;
  onCancel?: () => void;
  onClear?: () => void;
  streaming?: boolean;
  initialDraft?: string;
}

const DRAFT_KEY = 'alfred-chat-draft';
const MAX_ROWS = 12;

const COMMANDS: SlashCommand[] = [
  { cmd: '/help', description: 'Zeige verfügbare Befehle' },
  { cmd: '/clear', description: 'Conversation lokal leeren' },
  { cmd: '/skills', description: 'Aktive Skills auflisten' },
  { cmd: '/usage', description: 'Token-/Kosten-Verbrauch heute' },
  { cmd: '/history', description: 'Letzte Conversations öffnen' },
  { cmd: '/dashboard', description: 'Dashboard öffnen' },
  { cmd: '/knowledge', description: 'Knowledge-Graph öffnen' },
  { cmd: '/memories', description: 'Memory-Übersicht öffnen' },
  { cmd: '/runbooks', description: 'Runbooks auflisten' },
];

function estimateTokens(text: string): number {
  // OpenAI/Claude tokenization rough heuristic: ~4 chars/token for English, German is denser, use 3.5
  return Math.ceil(text.length / 3.5);
}

interface PendingAttachment { name: string; mime: string; dataUrl: string; sizeKB: number }

export function InputBar({ onSend, onCancel, onClear, streaming, initialDraft }: InputBarProps) {
  const { client } = useConfig();
  const [text, setText] = useState(initialDraft ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);

  // v644 — Multi-Modal: File-Upload + Voice
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  async function fileToAttachment(file: File): Promise<PendingAttachment | null> {
    if (file.size > 10 * 1024 * 1024) {
      alert(`Datei zu groß (${(file.size / 1024 / 1024).toFixed(1)} MB > 10 MB).`);
      return null;
    }
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { name: file.name, mime: file.type || 'application/octet-stream', dataUrl, sizeKB: Math.round(file.size / 1024) };
  }

  async function addFiles(files: FileList | File[]) {
    const additions: PendingAttachment[] = [];
    for (const f of Array.from(files)) {
      const a = await fileToAttachment(f);
      if (a) additions.push(a);
    }
    setAttachments(prev => [...prev, ...additions].slice(0, 8)); // max 8
  }

  // Drag & Drop on the whole InputBar
  function onDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragOver(true); }
  function onDragLeave() { setIsDragOver(false); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }
  // Paste handler — Bilder direkt einfügen
  async function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const f = items[i].getAsFile();
      if (f) files.push(f);
    }
    if (files.length > 0) {
      e.preventDefault();
      await addFiles(files);
    }
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
        if (blob.size < 1000) { setIsRecording(false); return; } // ignore <1KB
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

  // Restore draft on first mount (only if no initialDraft given)
  useEffect(() => {
    if (initialDraft !== undefined) return;
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) setText(stored);
    } catch {}
  }, [initialDraft]);

  // Persist draft as user types
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }, [text]);

  // Auto-resize textarea up to MAX_ROWS
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [text]);

  const slashQuery = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const firstLine = text.split('\n')[0];
    if (firstLine.includes(' ')) return null; // already typing args after cmd
    return firstLine.toLowerCase();
  }, [text]);

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    if (slashQuery === '/') return COMMANDS;
    return COMMANDS.filter(c => c.cmd.startsWith(slashQuery));
  }, [slashQuery]);

  useEffect(() => { setPaletteIndex(0); }, [slashQuery]);

  function applyCommand(cmd: SlashCommand) {
    if (cmd.cmd === '/clear') {
      onClear?.();
      setText('');
      return;
    }
    const routes: Record<string, string> = {
      '/history': '/alfred/history/',
      '/dashboard': '/alfred/dashboard/',
      '/knowledge': '/alfred/knowledge/',
      '/memories': '/alfred/memories/',
      '/runbooks': '/alfred/runbooks/',
    };
    if (routes[cmd.cmd]) {
      window.location.href = routes[cmd.cmd];
      return;
    }
    // /help, /skills, /usage → forward as message
    onSend(cmd.cmd);
    setText('');
  }

  const handleSend = () => {
    if ((!text.trim() && attachments.length === 0) || streaming) return;
    if (filteredCommands.length > 0 && slashQuery) {
      const exact = filteredCommands.find(c => c.cmd === text.trim());
      if (exact) { applyCommand(exact); return; }
    }
    onSend(text.trim(), attachments.length > 0 ? attachments.map(a => ({ name: a.name, mime: a.mime, dataUrl: a.dataUrl })) : undefined);
    setText('');
    setAttachments([]);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex(i => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = filteredCommands[paletteIndex];
        if (pick) setText(pick.cmd + ' ');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const charCount = text.length;
  const tokenCount = useMemo(() => estimateTokens(text), [text]);
  const showCounter = charCount > 0;

  return (
    <div
      className={`border-t border-[#1f1f1f] bg-[#111111] p-3 md:p-4 relative ${isDragOver ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
      />
      <div className="max-w-4xl mx-auto">
        {/* v644 — Attachments-Preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-2 py-1.5 text-xs">
                {a.mime.startsWith('image/') ? (
                  <img src={a.dataUrl} alt={a.name} className="w-10 h-10 object-cover rounded" />
                ) : (
                  <span className="text-2xl">📄</span>
                )}
                <div className="flex flex-col">
                  <span className="text-gray-200 max-w-[140px] truncate">{a.name}</span>
                  <span className="text-[10px] text-gray-500">{a.sizeKB} KB · {a.mime.split('/')[0]}</span>
                </div>
                <button
                  onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                  className="text-gray-500 hover:text-red-400 ml-1"
                  title="Entfernen"
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          <SlashCommandPalette
            visible={filteredCommands.length > 0}
            commands={filteredCommands}
            activeIndex={paletteIndex}
            onSelect={applyCommand}
            onHoverIndex={setPaletteIndex}
          />
          <div className="flex gap-1.5 md:gap-2 items-end">
            {/* v644 — File-Upload-Button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || attachments.length >= 8}
              className="bg-[#1a1a1a] hover:bg-[#222] disabled:opacity-30 text-gray-300 border border-[#2a2a2a] rounded-xl px-2.5 py-2.5 md:py-3 text-base"
              title="Datei anhängen (oder Drag&Drop / Paste)"
            >📎</button>
            {/* v644 — Voice-Recording-Button */}
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={streaming || transcribing}
              className={`rounded-xl px-2.5 py-2.5 md:py-3 text-base transition-colors ${
                isRecording ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                : transcribing ? 'bg-amber-600/20 text-amber-300 border border-amber-500/40'
                : 'bg-[#1a1a1a] hover:bg-[#222] text-gray-300 border border-[#2a2a2a]'
              }`}
              title={isRecording ? 'Aufnahme stoppen' : transcribing ? 'Transkribiere …' : 'Spracheingabe starten'}
            >{isRecording ? '⏹' : transcribing ? '…' : '🎤'}</button>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              placeholder={isDragOver ? '⬇ Dateien hier loslassen …' : 'Nachricht an Alfred …  (/ für Befehle, Shift+Enter neue Zeile)'}
              rows={1}
              className="flex-1 bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a] rounded-xl px-3 md:px-4 py-2.5 md:py-3 text-sm resize-none focus:outline-none focus:border-blue-500 placeholder-gray-500 leading-relaxed"
            />
            {streaming ? (
              <button
                onClick={onCancel}
                className="bg-red-600 hover:bg-red-700 text-white rounded-xl px-4 md:px-5 py-2.5 md:py-3 text-sm font-medium transition-colors flex items-center gap-2"
                title="Stream abbrechen"
              >
                <span className="inline-block w-2 h-2 bg-white rounded-sm" />
                <span className="hidden md:inline">Stop</span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim() && attachments.length === 0}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 md:px-5 py-2.5 md:py-3 text-sm font-medium transition-colors"
              >
                Senden
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-gray-500">
            <span>
              {showCounter ? (
                <>
                  <span className="font-mono">{charCount}</span> Zeichen · ≈
                  <span className="font-mono ml-1">{tokenCount}</span> Tokens
                </>
              ) : (
                <span className="text-gray-600">Tipp: / öffnet die Befehlspalette · ↑/↓ Navigation · Enter Senden</span>
              )}
            </span>
            {streaming && (
              <span className="flex items-center gap-1.5 text-blue-400">
                <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                Alfred antwortet …
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
