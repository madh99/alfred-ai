import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from './telegram.js';
import type { NormalizedMessage } from '@alfred/types';

/**
 * v926 — Media-Group-Aggregation: Telegram-Alben (N Updates mit gemeinsamer
 * media_group_id) werden zu EINER Nachricht mit Attachment-Array gebündelt.
 * Realfall 02.07.: 1 Album mit 6 Bildern erzeugte 6 parallele LLM-Antworten.
 * Getestet wird die Puffer-/Flush-Logik direkt (collectMediaGroupPart ist
 * privat → Zugriff via any; die grammy-Handler sind reine Durchreicher).
 */

const fakeMsg = (id: number, caption?: string) => ({
  message_id: id,
  date: 1780000000,
  chat: { id: 5060785419, type: 'private' },
  from: { id: 5060785419, is_bot: false, first_name: 'M' },
  ...(caption ? { caption } : {}),
}) as any;

const att = (n: number) => ({ type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from(`img${n}`) });

describe('v926 Telegram Media-Group-Aggregation', () => {
  let adapter: TelegramAdapter;
  let emitted: NormalizedMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = new TelegramAdapter('000000:TEST-TOKEN');
    emitted = [];
    adapter.on('message', (m: NormalizedMessage) => emitted.push(m));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('bündelt 3 Album-Teile zu EINER Nachricht mit 3 Attachments + Caption', () => {
    const a = adapter as any;
    a.collectMediaGroupPart('grp1', fakeMsg(1, 'Hier die Bilder zum rig'), att(1), 'Hier die Bilder zum rig');
    a.collectMediaGroupPart('grp1', fakeMsg(2), att(2), '');
    a.collectMediaGroupPart('grp1', fakeMsg(3), att(3), '');

    expect(emitted.length).toBe(0); // noch gepuffert
    vi.advanceTimersByTime(2600);   // Debounce abgelaufen
    expect(emitted.length).toBe(1); // EINE Nachricht
    expect(emitted[0].attachments?.length).toBe(3);
    expect(emitted[0].text).toBe('Hier die Bilder zum rig');
  });

  it('Debounce startet mit jedem Teil neu (kein vorzeitiger Flush)', () => {
    const a = adapter as any;
    a.collectMediaGroupPart('grp2', fakeMsg(1), att(1), '');
    vi.advanceTimersByTime(2000);
    a.collectMediaGroupPart('grp2', fakeMsg(2), att(2), ''); // Timer-Reset
    vi.advanceTimersByTime(2000);
    expect(emitted.length).toBe(0); // 4s vergangen, aber nie 2.5s Stille
    vi.advanceTimersByTime(600);
    expect(emitted.length).toBe(1);
    expect(emitted[0].attachments?.length).toBe(2);
  });

  it('ohne Caption: generischer Album-Text', () => {
    const a = adapter as any;
    a.collectMediaGroupPart('grp3', fakeMsg(1), att(1), '');
    a.collectMediaGroupPart('grp3', fakeMsg(2), att(2), '');
    vi.advanceTimersByTime(2600);
    expect(emitted[0].text).toContain('Album mit 2 Medien');
  });

  it('getrennte Gruppen bleiben getrennt', () => {
    const a = adapter as any;
    a.collectMediaGroupPart('grpA', fakeMsg(1, 'A'), att(1), 'A');
    a.collectMediaGroupPart('grpB', fakeMsg(2, 'B'), att(2), 'B');
    vi.advanceTimersByTime(2600);
    expect(emitted.length).toBe(2);
    expect(emitted.map(m => m.text).sort()).toEqual(['A', 'B']);
  });
});
