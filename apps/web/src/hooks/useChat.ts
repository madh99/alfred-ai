'use client';

import { useReducer, useCallback, useRef, useMemo } from 'react';
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
  | { type: 'ERROR'; error: string };

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
  }
}

/** Get or create a persistent user ID stored in localStorage. */
function getPersistentUserId(): string {
  if (typeof window === 'undefined') return 'web-user';
  const key = 'alfred-user-id';
  let userId = localStorage.getItem(key);
  if (!userId) {
    userId = `web-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(key, userId);
  }
  return userId;
}

/** Get or create a persistent chat ID stored in localStorage. */
function getPersistentChatId(): string {
  if (typeof window === 'undefined') return 'web-chat';
  const key = 'alfred-chat-id';
  let chatId = localStorage.getItem(key);
  if (!chatId) {
    chatId = `web-chat-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(key, chatId);
  }
  return chatId;
}

export function useChat() {
  const { client } = useConfig();
  const userId = useMemo(() => getPersistentUserId(), []);
  const chatId = useMemo(() => getPersistentChatId(), []);
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    streaming: false,
    currentStatus: null,
    error: null,
  });
  const cancelRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || state.streaming) return;

    dispatch({ type: 'ADD_USER', text });
    dispatch({ type: 'START_ASSISTANT' });

    cancelRef.current = client.streamMessage(text, chatId, userId, {
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

  return { ...state, sendMessage, cancel, userId, chatId };
}
