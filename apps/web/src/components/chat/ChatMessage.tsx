'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage as ChatMessageType } from '@/types/api';

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-[#1a1a1a] text-gray-200 border border-[#2a2a2a]'
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-[#0d0d0d] [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-blue-300 [&_a]:text-blue-400">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content || '...'}
            </ReactMarkdown>
          </div>
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
      </div>
    </div>
  );
}
