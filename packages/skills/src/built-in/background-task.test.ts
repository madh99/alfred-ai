import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import type { BackgroundTaskRepository } from '@alfred/storage';
import type { BackgroundTask } from '@alfred/types';
import { BackgroundTaskSkill } from './background-task.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

function createMockRepo(): BackgroundTaskRepository {
  const tasks: BackgroundTask[] = [];

  return {
    create: vi.fn((
      userId: string,
      platform: string,
      chatId: string,
      description: string,
      skillName: string,
      skillInput: string,
    ): BackgroundTask => {
      const task: BackgroundTask = {
        id: `task-${tasks.length + 1}`,
        userId,
        platform,
        chatId,
        description,
        skillName,
        skillInput,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    }),
    getByUser: vi.fn((userId: string) => tasks.filter((t) => t.userId === userId)),
    getPending: vi.fn(() => tasks.filter((t) => t.status === 'pending')),
    cancel: vi.fn((id: string) => {
      const idx = tasks.findIndex((t) => t.id === id && (t.status === 'pending' || t.status === 'running'));
      if (idx === -1) return false;
      tasks.splice(idx, 1);
      return true;
    }),
    updateStatus: vi.fn(),
    cleanup: vi.fn(() => 0),
  } as unknown as BackgroundTaskRepository;
}

describe('BackgroundTaskSkill', () => {
  let skill: BackgroundTaskSkill;
  let repo: BackgroundTaskRepository;

  beforeEach(() => {
    repo = createMockRepo();
    skill = new BackgroundTaskSkill(repo);
  });

  it('should schedule a task and return task id', async () => {
    const result = await skill.execute(
      {
        action: 'schedule',
        description: 'Fetch weather data',
        skill_name: 'web_search',
        skill_input: { q: 'weather' },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>).taskId).toBeDefined();
    expect((result.data as Record<string, unknown>).status).toBe('pending');
    expect((result.data as Record<string, unknown>).skillName).toBe('web_search');
    expect(repo.create).toHaveBeenCalledOnce();
  });

  it('should list tasks for user', async () => {
    // Schedule two tasks
    await skill.execute(
      { action: 'schedule', description: 'Task 1', skill_name: 'skill_a', skill_input: {} },
      ctx,
    );
    await skill.execute(
      { action: 'schedule', description: 'Task 2', skill_name: 'skill_b', skill_input: {} },
      ctx,
    );

    const result = await skill.execute({ action: 'list' }, ctx);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
  });

  it('should return empty list when no tasks exist', async () => {
    const result = await skill.execute({ action: 'list' }, ctx);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(0);
    expect(result.display).toContain('No active');
  });

  it('should cancel a pending task', async () => {
    const scheduleResult = await skill.execute(
      { action: 'schedule', description: 'To cancel', skill_name: 'skill_a', skill_input: {} },
      ctx,
    );

    const taskId = (scheduleResult.data as Record<string, unknown>).taskId as string;

    const cancelResult = await skill.execute(
      { action: 'cancel', task_id: taskId },
      ctx,
    );

    expect(cancelResult.success).toBe(true);
    expect((cancelResult.data as Record<string, unknown>).taskId).toBe(taskId);
    expect(repo.cancel).toHaveBeenCalledWith(taskId);
  });

  it('should return error when cancelling non-existent task', async () => {
    const result = await skill.execute(
      { action: 'cancel', task_id: 'non-existent' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error when description is missing for schedule', async () => {
    const result = await skill.execute(
      { action: 'schedule', skill_name: 'web_search' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('description');
  });

  it('should return error when skill_name is missing for schedule', async () => {
    const result = await skill.execute(
      { action: 'schedule', description: 'Some task' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('skill_name');
  });

  it('should return error when task_id is missing for cancel', async () => {
    const result = await skill.execute(
      { action: 'cancel' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('task_id');
  });

  it('should return error for unknown action', async () => {
    const result = await skill.execute(
      { action: 'unknown' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});
