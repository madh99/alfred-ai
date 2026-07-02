import { describe, it, expect, vi } from 'vitest';
import { QuickActionHandler } from './quick-actions.js';
import type { TodoRepository, ReminderRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform } from '@alfred/types';

/**
 * v924 — Quick-Actions: Button-Callbacks (todo:/reminder:) werden vor dem LLM
 * abgefangen und führen die Aktion direkt aus (Paket-1-Spam-Fix Teil 1).
 */

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

function makeHandler(overrides?: { todo?: any }) {
  const sent: string[] = [];
  const adapter = { sendMessage: vi.fn(async (_c: string, t: string) => { sent.push(t); }) } as unknown as MessagingAdapter;
  const todo = overrides?.todo ?? {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', userId: 'u1',
    title: 'Sensor-Batterien tauschen', completed: false, dueDate: '2026-07-01T10:00:00Z',
  };
  const todoRepo = {
    getById: vi.fn(async (id: string) => (id === todo.id ? todo : undefined)),
    complete: vi.fn(async () => true),
    update: vi.fn(async () => todo),
  } as unknown as TodoRepository;
  const reminderRepo = {
    getById: vi.fn(async () => ({ id: '11111111-2222-3333-4444-555555555555', userId: 'u1', platform: 'telegram', chatId: 'c1', message: 'Milch kaufen' })),
    create: vi.fn(async () => ({})),
  } as unknown as ReminderRepository;
  const adapters = new Map<Platform, MessagingAdapter>([['telegram' as Platform, adapter]]);
  return { handler: new QuickActionHandler(todoRepo, reminderRepo, adapters, logger), todoRepo, reminderRepo, sent, todo };
}

describe('v924 QuickActionHandler', () => {
  it('normale Nachrichten werden NICHT abgefangen', async () => {
    const { handler } = makeHandler();
    expect(await handler.handle('c1', 'telegram' as Platform, 'wie ist das Wetter?')).toBe(false);
    expect(await handler.handle('c1', 'telegram' as Platform, 'todo: einkaufen gehen')).toBe(false);
  });

  it('todo:<id>:done erledigt das Todo und antwortet', async () => {
    const { handler, todoRepo, sent, todo } = makeHandler();
    const handled = await handler.handle('c1', 'telegram' as Platform, `todo:${todo.id}:done`);
    expect(handled).toBe(true);
    expect(todoRepo.complete).toHaveBeenCalledWith(todo.id);
    expect(sent[0]).toContain('Erledigt');
  });

  it('todo:<id>:snooze verschiebt die Fälligkeit um ~24h', async () => {
    const { handler, todoRepo, todo } = makeHandler();
    await handler.handle('c1', 'telegram' as Platform, `todo:${todo.id}:snooze`);
    expect(todoRepo.update).toHaveBeenCalled();
    const patch = (todoRepo.update as any).mock.calls[0][2];
    expect(new Date(patch.dueDate).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it('bereits erledigtes Todo → Hinweis, kein complete-Call', async () => {
    const { handler, todoRepo, sent } = makeHandler({ todo: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', userId: 'u1', title: 'X', completed: true } });
    const handled = await handler.handle('c1', 'telegram' as Platform, 'todo:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:done');
    expect(handled).toBe(true);
    expect(todoRepo.complete).not.toHaveBeenCalled();
    expect(sent[0]).toContain('bereits erledigt');
  });

  it('reminder:<id>:snooze1h legt neuen Reminder an', async () => {
    const { handler, reminderRepo, sent } = makeHandler();
    const handled = await handler.handle('c1', 'telegram' as Platform, 'reminder:11111111-2222-3333-4444-555555555555:snooze1h');
    expect(handled).toBe(true);
    expect(reminderRepo.create).toHaveBeenCalled();
    expect(sent[0]).toContain('1 Stunde');
  });
});
