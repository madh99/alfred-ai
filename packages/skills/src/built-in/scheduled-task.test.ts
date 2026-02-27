import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import type { ScheduledActionRepository } from '@alfred/storage';
import type { ScheduledAction } from '@alfred/types';
import { ScheduledTaskSkill } from './scheduled-task.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

function createMockRepo(): ScheduledActionRepository {
  const actions: ScheduledAction[] = [];

  return {
    create: vi.fn((data: Record<string, unknown>): ScheduledAction => {
      const action: ScheduledAction = {
        id: `action-${actions.length + 1}`,
        userId: data.userId as string,
        platform: data.platform as string,
        chatId: data.chatId as string,
        name: data.name as string,
        description: data.description as string,
        scheduleType: data.scheduleType as ScheduledAction['scheduleType'],
        scheduleValue: data.scheduleValue as string,
        skillName: data.skillName as string,
        skillInput: data.skillInput as string,
        promptTemplate: data.promptTemplate as string | undefined,
        enabled: true,
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      actions.push(action);
      return action;
    }),
    getByUser: vi.fn((userId: string) => actions.filter((a) => a.userId === userId)),
    getDue: vi.fn(() => actions.filter((a) => a.enabled)),
    findById: vi.fn((id: string) => actions.find((a) => a.id === id)),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const action = actions.find((a) => a.id === id);
      if (!action) return false;
      action.enabled = enabled;
      return true;
    }),
    delete: vi.fn((id: string) => {
      const idx = actions.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      actions.splice(idx, 1);
      return true;
    }),
    updateLastRun: vi.fn(),
  } as unknown as ScheduledActionRepository;
}

describe('ScheduledTaskSkill', () => {
  let skill: ScheduledTaskSkill;
  let repo: ScheduledActionRepository;

  beforeEach(() => {
    repo = createMockRepo();
    skill = new ScheduledTaskSkill(repo);
  });

  it('should create a scheduled action and return its id', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        name: 'Daily digest',
        description: 'Send a daily digest of news',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'news_digest',
        skill_input: { topic: 'tech' },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>).actionId).toBeDefined();
    expect((result.data as Record<string, unknown>).name).toBe('Daily digest');
    expect((result.data as Record<string, unknown>).skillName).toBe('news_digest');
    expect(repo.create).toHaveBeenCalledOnce();
  });

  it('should create a scheduled action with cron schedule', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        name: 'Morning check',
        description: 'Check morning tasks',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        skill_name: 'task_check',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).scheduleType).toBe('cron');
  });

  it('should list actions for user', async () => {
    await skill.execute(
      {
        action: 'create',
        name: 'Action 1',
        description: 'Desc 1',
        schedule_type: 'interval',
        schedule_value: '30',
        skill_name: 'skill_a',
      },
      ctx,
    );
    await skill.execute(
      {
        action: 'create',
        name: 'Action 2',
        description: 'Desc 2',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'skill_b',
      },
      ctx,
    );

    const result = await skill.execute({ action: 'list' }, ctx);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
  });

  it('should return empty list when no actions exist', async () => {
    const result = await skill.execute({ action: 'list' }, ctx);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBe(0);
    expect(result.display).toContain('No scheduled actions');
  });

  it('should enable a disabled action', async () => {
    const createResult = await skill.execute(
      {
        action: 'create',
        name: 'Toggle me',
        description: 'Test toggle',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'skill_a',
      },
      ctx,
    );

    const actionId = (createResult.data as Record<string, unknown>).actionId as string;

    // Disable first
    await skill.execute({ action: 'disable', action_id: actionId }, ctx);
    expect(repo.setEnabled).toHaveBeenCalledWith(actionId, false);

    // Enable
    const enableResult = await skill.execute({ action: 'enable', action_id: actionId }, ctx);
    expect(enableResult.success).toBe(true);
    expect((enableResult.data as Record<string, unknown>).enabled).toBe(true);
    expect(repo.setEnabled).toHaveBeenCalledWith(actionId, true);
  });

  it('should disable an action', async () => {
    const createResult = await skill.execute(
      {
        action: 'create',
        name: 'Disable me',
        description: 'Test disable',
        schedule_type: 'interval',
        schedule_value: '30',
        skill_name: 'skill_a',
      },
      ctx,
    );

    const actionId = (createResult.data as Record<string, unknown>).actionId as string;

    const result = await skill.execute({ action: 'disable', action_id: actionId }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).enabled).toBe(false);
    expect(result.display).toContain('disabled');
  });

  it('should return error when enabling non-existent action', async () => {
    const result = await skill.execute(
      { action: 'enable', action_id: 'non-existent' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should delete an action', async () => {
    const createResult = await skill.execute(
      {
        action: 'create',
        name: 'Delete me',
        description: 'Test delete',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'skill_a',
      },
      ctx,
    );

    const actionId = (createResult.data as Record<string, unknown>).actionId as string;

    const deleteResult = await skill.execute(
      { action: 'delete', action_id: actionId },
      ctx,
    );

    expect(deleteResult.success).toBe(true);
    expect((deleteResult.data as Record<string, unknown>).actionId).toBe(actionId);
    expect(repo.delete).toHaveBeenCalledWith(actionId);

    // Verify it no longer shows up in list
    const listResult = await skill.execute({ action: 'list' }, ctx);
    expect((listResult.data as unknown[]).length).toBe(0);
  });

  it('should return error when deleting non-existent action', async () => {
    const result = await skill.execute(
      { action: 'delete', action_id: 'non-existent' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error when name is missing for create', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        description: 'Desc',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'skill_a',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('name');
  });

  it('should return error when description is missing for create', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        name: 'Test',
        schedule_type: 'interval',
        schedule_value: '60',
        skill_name: 'skill_a',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('description');
  });

  it('should return error when schedule_type is invalid', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        name: 'Test',
        description: 'Desc',
        schedule_type: 'invalid',
        schedule_value: '60',
        skill_name: 'skill_a',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('schedule_type');
  });

  it('should return error when skill_name is missing for create', async () => {
    const result = await skill.execute(
      {
        action: 'create',
        name: 'Test',
        description: 'Desc',
        schedule_type: 'interval',
        schedule_value: '60',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('skill_name');
  });

  it('should return error when action_id is missing for enable', async () => {
    const result = await skill.execute(
      { action: 'enable' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('action_id');
  });

  it('should return error when action_id is missing for delete', async () => {
    const result = await skill.execute(
      { action: 'delete' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('action_id');
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
