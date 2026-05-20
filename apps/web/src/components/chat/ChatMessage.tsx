'use client';

import { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage as ChatMessageType } from '@/types/api';

/**
 * v629 — Wiki-Style entity link rewrite.
 * Converts `[[Entity Name]]` in plain text into a Markdown link to the Knowledge-Graph
 * deep-link route, so ReactMarkdown's link handler picks it up. Skips occurrences inside
 * code fences (` ``` `) so code snippets are not mangled.
 */
function AssistantMarkdown({ content }: { content: string }) {
  const rendered = useMemo(() => rewriteEntityLinks(content || '...'), [content]);
  return (
    <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-[#0d0d0d] [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-blue-300 [&_a]:text-blue-400">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, title }) => {
            const isKgLink = href?.startsWith('/alfred/knowledge/?entity=');
            return (
              <a
                href={href}
                title={title}
                target={isKgLink ? '_self' : '_blank'}
                rel={isKgLink ? undefined : 'noopener noreferrer'}
                className={isKgLink
                  ? 'inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 hover:bg-purple-500/25 no-underline'
                  : 'text-blue-400 underline hover:text-blue-300'}
              >
                {isKgLink && <span className="text-[10px]">🧠</span>}
                {children}
              </a>
            );
          },
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
}

function rewriteEntityLinks(text: string): string {
  if (!text.includes('[[')) return text;
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (let i = 0; i < segments.length; i++) {
    // Even-indexed segments are outside of code fences/inline code
    if (i % 2 === 0) {
      segments[i] = segments[i].replace(/\[\[([^\]\n]{1,80})\]\]/g, (_m, name: string) => {
        const cleaned = name.trim();
        const url = `/alfred/knowledge/?entity=${encodeURIComponent(cleaned)}`;
        return `[${cleaned}](${url} "Knowledge-Graph: ${cleaned.replace(/"/g, '\\"')}")`;
      });
    }
  }
  return segments.join('');
}

interface Props {
  message: ChatMessageType;
  isLastUser?: boolean;
  isLastAssistant?: boolean;
  onRetry?: () => void;
  onEdit?: (newText: string) => void;
  streaming?: boolean;
}

export function ChatMessage({ message, isLastUser, isLastAssistant, onRetry, onEdit, streaming }: Props) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard may be unavailable on http:// */ }
  }

  function commitEdit() {
    if (!draft.trim()) return;
    setEditing(false);
    onEdit?.(draft.trim());
  }

  const canEdit = isUser && isLastUser && !streaming && onEdit;
  const canRetry = !isUser && isLastAssistant && !streaming && onRetry;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 group`}>
      <div
        className={`relative max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a]'
        }`}
      >
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              rows={Math.min(8, draft.split('\n').length + 1)}
              className="w-full bg-blue-800/40 text-white border border-blue-400 rounded-lg px-2 py-1.5 text-sm resize-y focus:outline-none"
            />
            <div className="flex items-center gap-2 justify-end text-xs">
              <button
                onClick={() => { setEditing(false); setDraft(message.content); }}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20"
              >Abbrechen</button>
              <button
                onClick={commitEdit}
                className="px-2 py-1 rounded bg-white text-blue-700 hover:bg-blue-50 font-medium"
              >Senden ↻</button>
            </div>
          </div>
        ) : isUser ? (
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <AssistantMarkdown content={message.content} />
        )}
        {message.attachments?.map((a, i) => (
          <div key={i} className="mt-2">
            {a.type === 'image' && (
              <img src={`data:image/png;base64,${a.data}`} alt={a.caption ?? 'Image'} className="rounded-lg max-w-full" />
            )}
            {a.type === 'file' && (
              <a href={`data:application/octet-stream;base64,${a.data}`} download={a.fileName} className="text-blue-400 underline text-sm">
                {a.fileName ?? 'Download'}
              </a>
            )}
            {a.type === 'voice' && (
              <audio controls src={`data:audio/ogg;base64,${a.data}`} className="mt-1" />
            )}
          </div>
        ))}

        {/* Hover-Actions (B4) */}
        {!editing && (
          <div className={`absolute ${isUser ? 'left-1 -top-3' : 'right-1 -top-3'} opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1`}>
            <button
              onClick={handleCopy}
              className="text-[10px] px-2 py-0.5 rounded bg-[#0d0d0d] border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] hover:border-blue-500/40"
              title="Inhalt kopieren"
            >
              {copied ? '✓ Kopiert' : '⧉ Copy'}
            </button>
            {canEdit && (
              <button
                onClick={() => { setDraft(message.content); setEditing(true); }}
                className="text-[10px] px-2 py-0.5 rounded bg-[#0d0d0d] border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] hover:border-blue-500/40"
                title="Letzte Nachricht bearbeiten & neu senden"
              >✎ Edit</button>
            )}
            {canRetry && (
              <button
                onClick={onRetry}
                className="text-[10px] px-2 py-0.5 rounded bg-[#0d0d0d] border border-[#2a2a2a] text-gray-300 hover:bg-[#1f1f1f] hover:border-blue-500/40"
                title="Antwort neu generieren"
              >↻ Retry</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
