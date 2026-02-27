import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('ScheduledActionRepository', () => {
  let dbPath: string;
  let db: Database;

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { ScheduledActionRepository } = await import('./scheduled-action-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-schedaction-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new ScheduledActionRepository(db.getDb());
    return repo;
  }

  it('should create an action with correct fields', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'chat-1',
      name: 'Daily report',
      description: 'Generate a daily report',
      scheduleType: 'interval',
      scheduleValue: '60',
      skillName: 'report_gen',
      skillInput: '{"type":"daily"}',
    });

    expect(action).toBeDefined();
    expect(action.id).toBeDefined();
    expect(typeof action.id).toBe('string');
    expect(action.userId).toBe('user-1');
    expect(action.platform).toBe('telegram');
    expect(action.chatId).toBe('chat-1');
    expect(action.name).toBe('Daily report');
    expect(action.description).toBe('Generate a daily report');
    expect(action.scheduleType).toBe('interval');
    expect(action.scheduleValue).toBe('60');
    expect(action.skillName).toBe('report_gen');
    expect(action.skillInput).toBe('{"type":"daily"}');
    expect(action.enabled).toBe(true);
    expect(action.createdAt).toBeDefined();
    expect(action.nextRunAt).toBeDefined();
  });

  it('should create an action with cron schedule', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'chat-1',
      name: 'Cron job',
      description: 'Run on cron',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      skillName: 'cron_skill',
      skillInput: '{}',
    });

    expect(action.scheduleType).toBe('cron');
    expect(action.scheduleValue).toBe('0 9 * * *');
    // nextRunAt should be calculated for cron
    expect(action.nextRunAt).toBeDefined();
  });

  it('should create an action with promptTemplate', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'chat-1',
      name: 'Prompt task',
      description: 'Run a prompt',
      scheduleType: 'interval',
      scheduleValue: '30',
      skillName: 'llm_prompt',
      skillInput: '{}',
      promptTemplate: 'Summarize the news today',
    });

    expect(action.promptTemplate).toBe('Summarize the news today');
  });

  it('should return actions for a specific user via getByUser', async () => {
    const repo = await setup();

    repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Action 1',
      description: 'Desc 1',
      scheduleType: 'interval',
      scheduleValue: '60',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    repo.create({
      userId: 'user-2',
      platform: 'telegram',
      chatId: 'c2',
      name: 'Action 2',
      description: 'Desc 2',
      scheduleType: 'interval',
      scheduleValue: '30',
      skillName: 'skill_b',
      skillInput: '{}',
    });

    repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Action 3',
      description: 'Desc 3',
      scheduleType: 'interval',
      scheduleValue: '120',
      skillName: 'skill_c',
      skillInput: '{}',
    });

    const user1Actions = repo.getByUser('user-1');
    const user2Actions = repo.getByUser('user-2');

    expect(user1Actions.length).toBe(2);
    expect(user2Actions.length).toBe(1);
    expect(user1Actions.every((a) => a.userId === 'user-1')).toBe(true);
  });

  it('should return due actions via getDue', async () => {
    const repo = await setup();

    // Create an interval action that should be due soon
    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Due action',
      description: 'Should be due',
      scheduleType: 'interval',
      scheduleValue: '1',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    // Manually set next_run_at to the past so it's considered due
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    db.getDb().prepare('UPDATE scheduled_actions SET next_run_at = ? WHERE id = ?').run(pastDate, action.id);

    const due = repo.getDue();

    expect(due.length).toBe(1);
    expect(due[0].id).toBe(action.id);
    expect(due[0].enabled).toBe(true);
  });

  it('should not return disabled actions in getDue', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Disabled action',
      description: 'Should not be due',
      scheduleType: 'interval',
      scheduleValue: '1',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    // Set next_run_at to the past
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    db.getDb().prepare('UPDATE scheduled_actions SET next_run_at = ? WHERE id = ?').run(pastDate, action.id);

    // Disable the action
    repo.setEnabled(action.id, false);

    const due = repo.getDue();
    expect(due.length).toBe(0);
  });

  it('should update last run timestamps via updateLastRun', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Update run',
      description: 'Test update',
      scheduleType: 'interval',
      scheduleValue: '60',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    const lastRunAt = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + 60 * 60_000).toISOString();

    repo.updateLastRun(action.id, lastRunAt, nextRunAt);

    const found = repo.findById(action.id);
    expect(found).toBeDefined();
    expect(found!.lastRunAt).toBe(lastRunAt);
    expect(found!.nextRunAt).toBe(nextRunAt);
  });

  it('should toggle enabled via setEnabled', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Toggle me',
      description: 'Test toggle',
      scheduleType: 'interval',
      scheduleValue: '60',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    expect(action.enabled).toBe(true);

    const disabled = repo.setEnabled(action.id, false);
    expect(disabled).toBe(true);

    const found = repo.findById(action.id);
    expect(found).toBeDefined();
    expect(found!.enabled).toBe(false);

    const enabled = repo.setEnabled(action.id, true);
    expect(enabled).toBe(true);

    const found2 = repo.findById(action.id);
    expect(found2!.enabled).toBe(true);
  });

  it('should return false for setEnabled on non-existent action', async () => {
    const repo = await setup();

    const result = repo.setEnabled('non-existent-id', true);
    expect(result).toBe(false);
  });

  it('should delete an action', async () => {
    const repo = await setup();

    const action = repo.create({
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'c1',
      name: 'Delete me',
      description: 'Test delete',
      scheduleType: 'interval',
      scheduleValue: '60',
      skillName: 'skill_a',
      skillInput: '{}',
    });

    const deleted = repo.delete(action.id);
    expect(deleted).toBe(true);

    const found = repo.findById(action.id);
    expect(found).toBeUndefined();
  });

  it('should return false when deleting non-existent action', async () => {
    const repo = await setup();

    const deleted = repo.delete('non-existent-id');
    expect(deleted).toBe(false);
  });
});
