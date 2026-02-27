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

describe.skipIf(!hasBetterSqlite3)('BackgroundTaskRepository', () => {
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
    const { BackgroundTaskRepository } = await import('./background-task-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-bgtask-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new BackgroundTaskRepository(db.getDb());
    return repo;
  }

  it('should create a task with correct fields', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'chat-1', 'Fetch data', 'web_search', '{"q":"test"}');

    expect(task).toBeDefined();
    expect(task.id).toBeDefined();
    expect(typeof task.id).toBe('string');
    expect(task.userId).toBe('user-1');
    expect(task.platform).toBe('telegram');
    expect(task.chatId).toBe('chat-1');
    expect(task.description).toBe('Fetch data');
    expect(task.skillName).toBe('web_search');
    expect(task.skillInput).toBe('{"q":"test"}');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeDefined();
  });

  it('should return only pending tasks via getPending', async () => {
    const repo = await setup();

    const t1 = repo.create('user-1', 'telegram', 'c1', 'task 1', 'skill_a', '{}');
    const t2 = repo.create('user-1', 'telegram', 'c1', 'task 2', 'skill_b', '{}');
    repo.create('user-1', 'telegram', 'c1', 'task 3', 'skill_c', '{}');

    // Mark t1 as running, t2 stays pending, t3 stays pending
    repo.updateStatus(t1.id, 'running');

    const pending = repo.getPending();

    expect(pending.length).toBe(2);
    expect(pending.every((t) => t.status === 'pending')).toBe(true);
    expect(pending.find((t) => t.id === t2.id)).toBeDefined();
  });

  it('should respect limit in getPending', async () => {
    const repo = await setup();

    repo.create('user-1', 'telegram', 'c1', 'task 1', 'skill_a', '{}');
    repo.create('user-1', 'telegram', 'c1', 'task 2', 'skill_b', '{}');
    repo.create('user-1', 'telegram', 'c1', 'task 3', 'skill_c', '{}');

    const pending = repo.getPending(2);
    expect(pending.length).toBe(2);
  });

  it('should set started_at when status changes to running', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'run me', 'skill_a', '{}');
    repo.updateStatus(task.id, 'running');

    const tasks = repo.getPending(100);
    // Task is no longer pending, verify via getByUser
    const userTasks = repo.getByUser('user-1');
    const updated = userTasks.find((t) => t.id === task.id);

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.startedAt).toBeDefined();
  });

  it('should set completed_at when status changes to completed', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'complete me', 'skill_a', '{}');
    repo.updateStatus(task.id, 'running');
    repo.updateStatus(task.id, 'completed', 'done!');

    const userTasks = repo.getByUser('user-1');
    const updated = userTasks.find((t) => t.id === task.id);

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('completed');
    expect(updated!.completedAt).toBeDefined();
    expect(updated!.result).toBe('done!');
  });

  it('should set completed_at and error when status changes to failed', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'fail me', 'skill_a', '{}');
    repo.updateStatus(task.id, 'failed', undefined, 'something broke');

    const userTasks = repo.getByUser('user-1');
    const updated = userTasks.find((t) => t.id === task.id);

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('failed');
    expect(updated!.completedAt).toBeDefined();
    expect(updated!.error).toBe('something broke');
  });

  it('should return tasks for specific user via getByUser', async () => {
    const repo = await setup();

    repo.create('user-1', 'telegram', 'c1', 'user1 task', 'skill_a', '{}');
    repo.create('user-2', 'telegram', 'c2', 'user2 task', 'skill_b', '{}');
    repo.create('user-1', 'telegram', 'c1', 'user1 task 2', 'skill_c', '{}');

    const user1Tasks = repo.getByUser('user-1');
    const user2Tasks = repo.getByUser('user-2');

    expect(user1Tasks.length).toBe(2);
    expect(user2Tasks.length).toBe(1);
    expect(user1Tasks.every((t) => t.userId === 'user-1')).toBe(true);
    expect(user2Tasks[0].userId).toBe('user-2');
  });

  it('should cancel a pending task', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'cancel me', 'skill_a', '{}');
    const cancelled = repo.cancel(task.id);

    expect(cancelled).toBe(true);

    const pending = repo.getPending();
    expect(pending.find((t) => t.id === task.id)).toBeUndefined();
  });

  it('should return false when cancelling a completed task', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'done task', 'skill_a', '{}');
    repo.updateStatus(task.id, 'completed', 'result');

    const cancelled = repo.cancel(task.id);
    expect(cancelled).toBe(false);
  });

  it('should return false when cancelling a non-existent task', async () => {
    const repo = await setup();

    const cancelled = repo.cancel('non-existent-id');
    expect(cancelled).toBe(false);
  });

  it('should cleanup old completed tasks', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'old task', 'skill_a', '{}');
    repo.updateStatus(task.id, 'completed', 'done');

    // With olderThanDays=0, any completed task should be cleaned up
    const removed = repo.cleanup(0);
    expect(removed).toBe(1);
  });

  it('should not cleanup recent completed tasks', async () => {
    const repo = await setup();

    const task = repo.create('user-1', 'telegram', 'c1', 'recent task', 'skill_a', '{}');
    repo.updateStatus(task.id, 'completed', 'done');

    // With a high olderThanDays value, recent tasks should not be cleaned up
    const removed = repo.cleanup(30);
    expect(removed).toBe(0);
  });
});
