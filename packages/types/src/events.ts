import type { NormalizedMessage, Platform } from './messaging.js';

export interface AlfredMessageEvent {
  type: 'message';
  message: NormalizedMessage;
  response: string;
  timestamp: Date;
}

export interface AlfredErrorEvent {
  type: 'error';
  error: Error;
  platform?: Platform;
  timestamp: Date;
}

export interface AlfredConnectionEvent {
  type: 'connected' | 'disconnected';
  platform: Platform;
  timestamp: Date;
}

export type AlfredEvent = AlfredMessageEvent | AlfredErrorEvent | AlfredConnectionEvent;
