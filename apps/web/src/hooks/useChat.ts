'use client';

import { useReducer, useCallback, useRef, useMemo, useEffect } from 'react';
import type { ChatMessage, Attachment } from '@/types/api';
import { useConfig } from '@/context/ConfigContext';

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  currentStatus: string | null;
  error: string | null;
}

type Action =
  | { type: 'ADD_USER'; text: string }
  | { type: 'START_ASSISTANT' }
  | { type: 'APPEND_RESPONSE'; text: string }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'ADD_ATTACHMENT'; attachment: Attachment }
  | { type: 'DONE' }
  | { type: 'ERROR'; error: string }
  | { type: 'CLEAR' }
  | { type: 'DROP_LAST_ASSISTANT' }
  | { type: 'EDIT_LAST_USER'; text: string };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'ADD_USER':
      return {
        ...state,
        messages: [...state.messages, {
          id: `user-${Date.now()}`,
          role: 'user',
          content: action.text,
          timestamp: Date.now(),
        }],
        error: null,
      };
    case 'START_ASSISTANT':
      return {
        ...state,
        streaming: true,
        currentStatus: null,
        messages: [...state.messages, {
          id: `asst-${Date.now()}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        }],
      };
    case 'APPEND_RESPONSE': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + action.text };
      }
      return { ...state, messages: msgs, currentStatus: null };
    }
    case 'SET_STATUS':
      return { ...state, currentStatus: action.text };
    case 'ADD_ATTACHMENT': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        const attachments = [...(last.attachments ?? []), action.attachment];
        msgs[msgs.length - 1] = { ...last, attachments };
      }
      return { ...state, messages: msgs };
    }
    case 'DONE':
      return { ...state, streaming: false, currentStatus: null };
    case 'ERROR':
      return { ...state, streaming: false, currentStatus: null, error: action.error };
    case 'CLEAR':
      return { messages: [], streaming: false, currentStatus: null, error: null };
    case 'DROP_LAST_ASSISTANT': {
      const msgs = [...state.messages];
      while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
      return { ...state, messages: msgs };
    }
    case 'EDIT_LAST_USER': {
      const msgs = [...state.messages];
      // Drop trailing assistant + last user; we'll re-add user via ADD_USER + START_ASSISTANT in sendMessage
      while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs.pop();
      return { ...state, messages: msgs };
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function getPersistentUserId(): string {
  if (typeof window === 'undefined') return 'web-user';
  const key = 'alfred-user-id';
  let userId = localStorage.getItem(key);
  if (!userId) { userId = `web-${randomId()}`; localStorage.setItem(key, userId); }
  return userId;
}

function getPersistentChatId(): string {
  if (typeof window === 'undefined') return 'web-chat';
  const key = 'alfred-chat-id';
  let chatId = localStorage.getItem(key);
  if (!chatId) { chatId = `web-chat-${randomId()}`; localStorage.setItem(key, chatId); }
  return chatId;
}

const MESSAGES_PERSIST_KEY = 'alfred-chat-messages';
const MESSAGES_PERSIST_MAX = 200;

function loadPersistedMessages(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(MESSAGES_PERSIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MESSAGES_PERSIST_MAX) : [];
  } catch { return []; }
}

export function useChat() {
  const { client, user: authUser } = useConfig();
  const userId = useMemo(() => authUser?.userId ? `web-${authUser.userId}` : getPersistentUserId(), [authUser]);
  const chatId = useMemo(() => authUser?.userId ? `web-chat-${authUser.userId}` : getPersistentChatId(), [authUser]);
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    messages: loadPersistedMessages(),
    streaming: false,
    currentStatus: null,
    error: null,
  }));
  const cancelRef = useRef<(() => void) | null>(null);

  // Persist messages to localStorage (B6 - state-persist across reloads)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (state.streaming) return; // wait for stream to finish before persisting
    try {
      localStorage.setItem(MESSAGES_PERSIST_KEY, JSON.stringify(state.messages.slice(-MESSAGES_PERSIST_MAX)));
    } catch {}
  }, [state.messages, state.streaming]);

  const sendMessage = useCallback((text: string, attachments?: Array<{ name: string; mime: string; dataUrl: string }>) => {
    if ((!text.trim() && (!attachments || attachments.length === 0)) || state.streaming) return;
    // v644 — Bilder als Markdown ![]() inlinen, andere Files als download-Tag (best-effort —
    // bei größeren Files sollte später ein Upload-Endpoint genutzt werden).
    let fullText = text.trim();
    if (attachments && attachments.length > 0) {
      const lines: string[] = [];
      for (const a of attachments) {
        if (a.mime.startsWith('image/')) {
          lines.push(`![${a.name}](${a.dataUrl})`);
        } else {
          lines.push(`[📄 ${a.name}](${a.dataUrl})`);
        }
      }
      fullText = fullText ? `${fullText}\n\n${lines.join('\n')}` : lines.join('\n');
    }
    dispatch({ type: 'ADD_USER', text: fullText });
    dispatch({ type: 'START_ASSISTANT' });
    cancelRef.current = client.streamMessage(fullText, chatId, userId, {
      onStatus: (t) => dispatch({ type: 'SET_STATUS', text: t }),
      onResponse: (t) => dispatch({ type: 'APPEND_RESPONSE', text: t }),
      onAttachment: (a) => dispatch({ type: 'ADD_ATTACHMENT', attachment: a }),
      onDone: () => dispatch({ type: 'DONE' }),
      onError: (e) => dispatch({ type: 'ERROR', error: e }),
    });
  }, [client, chatId, userId, state.streaming]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    dispatch({ type: 'DONE' });
  }, []);

  /** B1/B4 — drop last assistant message and re-run the last user message. */
  const retryLast = useCallback(() => {
    if (state.streaming) return;
    const lastUser = [...state.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    dispatch({ type: 'DROP_LAST_ASSISTANT' });
    // re-fire — but skip ADD_USER since user message remains
    dispatch({ type: 'START_ASSISTANT' });
    cancelRef.current = client.streamMessage(lastUser.content, chatId, userId, {
      onStatus: (t) => dispatch({ type: 'SET_STATUS', text: t }),
      onResponse: (t) => dispatch({ type: 'APPEND_RESPONSE', text: t }),
      onAttachment: (a) => dispatch({ type: 'ADD_ATTACHMENT', attachment: a }),
      onDone: () => dispatch({ type: 'DONE' }),
      onError: (e) => dispatch({ type: 'ERROR', error: e }),
    });
  }, [client, chatId, userId, state.messages, state.streaming]);

  /** B5 — edit the last user message in-place and re-fire. */
  const editLastUser = useCallback((newText: string) => {
    if (state.streaming) return;
    dispatch({ type: 'EDIT_LAST_USER', text: newText });
    // small defer so dispatch settles, then send fresh
    setTimeout(() => sendMessage(newText), 0);
  }, [state.streaming, sendMessage]);

  const clearMessages = useCallback(() => {
    dispatch({ type: 'CLEAR' });
    if (typeof window !== 'undefined') {
      try { localStorage.removeItem(MESSAGES_PERSIST_KEY); } catch {}
    }
  }, []);

  return {
    ...state,
    sendMessage, cancel, retryLast, editLastUser, clearMessages,
    userId, chatId,
  };
}
