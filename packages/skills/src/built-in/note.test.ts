import { describe, it, expect, beforeEach } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { NoteSkill } from './note.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

/** In-memory mock that implements the NoteRepository interface */
function createMockRepo() {
  const notes = new Map<string, { id: string; userId: string; title: string; content: string; createdAt: string; updatedAt: string }>();
  let counter = 0;

  return {
    save(userId: string, title: string, content: string) {
      const id = `note-${++counter}`;
      const now = new Date().toISOString();
      const entry = { id, userId, title, content, createdAt: now, updatedAt: now };
      notes.set(id, entry);
      return entry;
    },
    getById(noteId: string) {
      return notes.get(noteId);
    },
    list(userId: string) {
      return [...notes.values()].filter(n => n.userId === userId);
    },
    search(userId: string, query: string) {
      const q = query.toLowerCase();
      return [...notes.values()].filter(
        n => n.userId === userId && (n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)),
      );
    },
    update(noteId: string, title?: string, content?: string) {
      const e = notes.get(noteId);
      if (!e) return undefined;
      if (title) e.title = title;
      if (content) e.content = content;
      e.updatedAt = new Date().toISOString();
      return e;
    },
    delete(noteId: string) {
      return notes.delete(noteId);
    },
  };
}

describe('NoteSkill', () => {
  let skill: NoteSkill;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    skill = new NoteSkill(createMockRepo() as any);
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
