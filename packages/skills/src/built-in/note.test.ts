import { describe, it, expect, beforeEach } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { NoteSkill } from './note.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

describe('NoteSkill', () => {
  let skill: NoteSkill;

  beforeEach(() => {
    skill = new NoteSkill();
  });

  it('should save a note', async () => {
    const result = await skill.execute(
      { action: 'save', title: 'Test', content: 'Hello' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>).noteId).toBeDefined();
    expect(typeof (result.data as Record<string, unknown>).noteId).toBe('string');
  });

  it('should list notes for user', async () => {
    await skill.execute({ action: 'save', title: 'Note 1', content: 'Content 1' }, ctx);
    await skill.execute({ action: 'save', title: 'Note 2', content: 'Content 2' }, ctx);

    const listResult = await skill.execute({ action: 'list' }, ctx);

    expect(listResult.success).toBe(true);
    expect(Array.isArray(listResult.data)).toBe(true);
    expect((listResult.data as unknown[]).length).toBe(2);
  });

  it('should search notes by query', async () => {
    await skill.execute({ action: 'save', title: 'Groceries', content: 'Buy milk' }, ctx);
    await skill.execute({ action: 'save', title: 'Meeting', content: 'Discuss project' }, ctx);

    const searchResult = await skill.execute(
      { action: 'search', query: 'Groceries' },
      ctx,
    );

    expect(searchResult.success).toBe(true);
    expect(Array.isArray(searchResult.data)).toBe(true);
    expect((searchResult.data as unknown[]).length).toBe(1);

    const match = (searchResult.data as Array<Record<string, unknown>>)[0];
    expect(match.title).toBe('Groceries');
  });

  it('should delete a note', async () => {
    const saveResult = await skill.execute(
      { action: 'save', title: 'To Delete', content: 'Temporary' },
      ctx,
    );

    const noteId = (saveResult.data as Record<string, unknown>).noteId as string;

    const deleteResult = await skill.execute({ action: 'delete', noteId }, ctx);
    expect(deleteResult.success).toBe(true);

    const listResult = await skill.execute({ action: 'list' }, ctx);
    expect((listResult.data as unknown[]).length).toBe(0);
  });
});
