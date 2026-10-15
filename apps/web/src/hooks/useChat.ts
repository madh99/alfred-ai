'use client';

import { useReducer, useCallback, useRef, useMemo, useEffect, useState } from 'react';
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
  // v1330 — Gespräche kanalunabhängig: `?faden=<id>` öffnet einen Faden des Owners (web-faden-<id>),
  // ohne Parameter das Hauptgespräch (web-chat-<user> wird serverseitig darauf abgebildet).
  const faden = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const f = new URLSearchParams(window.location.search).get('faden');
    return f && /^[a-z0-9-]{1,40}$/.test(f) ? f : null;
  }, []);
  const chatId = useMemo(() => faden ? `web-faden-${faden}` : authUser?.userId ? `web-chat-${authUser.userId}` : getPersistentChatId(), [authUser, faden]);
  // v1330 — Verlauf des Gesprächs vom Server (was in Telegram oder der App lief, steht hier auch)
  const verlaufGeladenRef = useRef(false);
  useEffect(() => {
    if (!client || verlaufGeladenRef.current) return;
    verlaufGeladenRef.current = true;
    (async () => {
      try {
        const msgs = await client.fetchGespraechVerlauf(faden, 200);
        if (msgs.length === 0 && faden) { dispatch({ type: 'CLEAR' }); return; }
        if (msgs.length === 0) return;
        dispatch({ type: 'CLEAR' });
        for (const m of msgs) {
          if (m.rolle === 'user') dispatch({ type: 'ADD_USER', text: m.text });
          else if ((m.rolle as string) === 'system') { dispatch({ type: 'START_ASSISTANT' }); dispatch({ type: 'APPEND_RESPONSE', text: `ℹ ${m.text.split('\n')[0]}` }); dispatch({ type: 'DONE' }); } // v1336 — interne Fortsetzung als Hinweis
          else { dispatch({ type: 'START_ASSISTANT' }); dispatch({ type: 'APPEND_RESPONSE', text: m.text }); dispatch({ type: 'DONE' }); }
        }
      } catch { /* kein Owner oder Server ohne Gespräche: lokaler Verlauf bleibt */ }
    })();
  }, [client, faden]);
  // v647 — Active-Conversation-ID aus localStorage (von Sidebar "Chat fortsetzen")
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return localStorage.getItem('alfred-chat-active-conversation-id'); } catch { return null; }
  });
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    messages: loadPersistedMessages(),
    streaming: false,
    currentStatus: null,
    error: null,
  }));
  const cancelRef = useRef<(() => void) | null>(null);
  const gesendetRef = useRef<{ anzeige: string; server: string } | null>(null); // v1469

  // Persist messages to localStorage (B6 - state-persist across reloads)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (state.streaming) return; // wait for stream to finish before persisting
    try {
      localStorage.setItem(MESSAGES_PERSIST_KEY, JSON.stringify(state.messages.slice(-MESSAGES_PERSIST_MAX)));
    } catch {}
  }, [state.messages, state.streaming]);

  // v647 — Wenn eine activeConvId gesetzt ist (von Sidebar/History "Im Chat fortsetzen"),
  // lade einmalig die Messages dieser Conversation in den Chat-State.
  // Räume die Flag-Variable danach auf damit Reload nicht doppelt lädt.
  const loadedConvOnceRef = useRef(false);
  useEffect(() => {
    if (!activeConvId || !client || loadedConvOnceRef.current) return;
    loadedConvOnceRef.current = true;
    (async () => {
      try {
        const msgs = await client.fetchConversationMessages(activeConvId, { limit: 500 });
        if (msgs.length > 0) {
          dispatch({ type: 'CLEAR' });
          for (const m of msgs) {
            if (m.role === 'user') dispatch({ type: 'ADD_USER', text: m.content });
            else if (m.role === 'assistant') { dispatch({ type: 'START_ASSISTANT' }); dispatch({ type: 'APPEND_RESPONSE', text: m.content }); dispatch({ type: 'DONE' }); }
          }
        }
      } catch { /* silent: degrade to empty chat */ }
      // Clear the flag so next reload doesn't repeat
      try { localStorage.removeItem('alfred-chat-active-conversation-id'); } catch {}
      setActiveConvId(null);
    })();
  }, [activeConvId, client]);

  const sendMessage = useCallback((
    text: string,
    attachments?: Array<{ name: string; mime: string; dataUrl: string }>,
    /** v657 — optional Reply-Kontext (vom Reply-Button in der Chat-UI) */
    replyTo?: { messageId?: string; text?: string; from?: string },
  ) => {
    if ((!text.trim() && (!attachments || attachments.length === 0)) || state.streaming) return;
    const eingabe = text.trim();
    if (!attachments || attachments.length === 0) { senden(eingabe, eingabe, replyTo); return; }
    // v1469 — Anhänge in den Dateispeicher hochladen und wie die App nur die Upload-Zeile mit dem Schlüssel schicken
    // (vorher Base64 im Text: über ~750 KB scheiterte das 1-MB-Limit, darunter sah das Modell nur Zeichensalat).
    // Die Anzeige im Chat behält die lokale Vorschau.
    const vorschau = attachments.map(a => (a.mime.startsWith('image/') ? `![${a.name}](${a.dataUrl})` : `📎 ${a.name}`)).join('\n');
    const anzeige = eingabe ? `${eingabe}\n\n${vorschau}` : vorschau;
    dispatch({ type: 'ADD_USER', text: anzeige });
    dispatch({ type: 'START_ASSISTANT' });
    dispatch({ type: 'SET_STATUS', text: `⬆ ${attachments.length === 1 ? 'Anhang wird' : `${attachments.length} Anhänge werden`} hochgeladen …` });
    void (async () => {
      const zeilen: string[] = [];
      for (const a of attachments) {
        const i = a.dataUrl.indexOf(',');
        const hoch = await client.uploadFileBase64(a.name, a.mime, i >= 0 ? a.dataUrl.slice(i + 1) : a.dataUrl).catch(() => null);
        if (!hoch) { dispatch({ type: 'ERROR', error: `Upload von „${a.name}“ fehlgeschlagen — Nachricht nicht gesendet.` }); return; }
        zeilen.push(`Datei „${a.name}“ (${hoch.size} Bytes) liegt in deinem Dateispeicher, Schlüssel: ${hoch.key}.`);
      }
      const serverText = eingabe ? `${zeilen.join('\n')}\n${eingabe}` : zeilen.join('\n');
      gesendetRef.current = { anzeige, server: serverText }; // v1469 — „erneut senden“ schickt die Upload-Zeilen, nicht die lokale Vorschau
      senden(serverText, undefined, replyTo);
    })();
  }, [client, chatId, userId, state.streaming]);

  /** Nachricht an den Server; anzeigeText gesetzt = Nutzerzeile hier anlegen (sonst schon angelegt). */
  const senden = useCallback((serverText: string, anzeigeText: string | undefined, replyTo?: { messageId?: string; text?: string; from?: string }) => {
    if (anzeigeText !== undefined) {
      dispatch({ type: 'ADD_USER', text: anzeigeText });
      dispatch({ type: 'START_ASSISTANT' });
    }
    cancelRef.current = client.streamMessage(serverText, chatId, userId, {
      onStatus: (t) => dispatch({ type: 'SET_STATUS', text: t }),
      onResponse: (t) => dispatch({ type: 'APPEND_RESPONSE', text: t }),
      onAttachment: (a) => dispatch({ type: 'ADD_ATTACHMENT', attachment: a }),
      onDone: () => dispatch({ type: 'DONE' }),
      onError: (e) => dispatch({ type: 'ERROR', error: e }),
    }, replyTo);
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
    cancelRef.current = client.streamMessage(gesendetRef.current?.anzeige === lastUser.content ? gesendetRef.current.server : lastUser.content, chatId, userId, {
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
