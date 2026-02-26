import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { randomUUID } from 'node:crypto';
import { Skill } from '../skill.js';

interface NoteEntry {
  noteId: string;
  userId: string;
  title: string;
  content: string;
  createdAt: number;
}

type NoteAction = 'save' | 'list' | 'search' | 'delete';

export class NoteSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'note',
    description: 'Save, list, search, or delete notes',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'delete'],
          description: 'The note action to perform',
        },
        title: {
          type: 'string',
          description: 'The note title (required for save)',
        },
        content: {
          type: 'string',
          description: 'The note content (required for save)',
        },
        noteId: {
          type: 'string',
          description: 'The ID of the note to delete (required for delete)',
        },
        query: {
          type: 'string',
          description: 'Search query to filter notes (required for search)',
        },
      },
      required: ['action'],
    },
  };

  private readonly notes: Map<string, NoteEntry> = new Map();

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as NoteAction;

    switch (action) {
      case 'save':
        return this.saveNote(input, context);
      case 'list':
        return this.listNotes(context);
      case 'search':
        return this.searchNotes(input, context);
      case 'delete':
        return this.deleteNote(input);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: save, list, search, delete`,
        };
    }
  }

  private saveNote(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const title = input.title as string | undefined;
    const content = input.content as string | undefined;

    if (!title || typeof title !== 'string') {
      return {
        success: false,
        error: 'Missing required field "title" for save action',
      };
    }

    if (!content || typeof content !== 'string') {
      return {
        success: false,
        error: 'Missing required field "content" for save action',
      };
    }

    const noteId = randomUUID();
    const createdAt = Date.now();

    this.notes.set(noteId, {
      noteId,
      userId: context.userId,
      title,
      content,
      createdAt,
    });

    return {
      success: true,
      data: { noteId, title, createdAt },
      display: `Note saved (${noteId}): "${title}"`,
    };
  }

  private listNotes(context: SkillContext): SkillResult {
    const userNotes: Array<{ noteId: string; title: string; createdAt: number }> = [];

    for (const [, entry] of this.notes) {
      if (entry.userId === context.userId) {
        userNotes.push({
          noteId: entry.noteId,
          title: entry.title,
          createdAt: entry.createdAt,
        });
      }
    }

    return {
      success: true,
      data: userNotes,
      display:
        userNotes.length === 0
          ? 'No notes found.'
          : `Notes:\n${userNotes.map((n) => `- ${n.noteId}: "${n.title}"`).join('\n')}`,
    };
  }

  private searchNotes(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const query = input.query as string | undefined;

    if (!query || typeof query !== 'string') {
      return {
        success: false,
        error: 'Missing required field "query" for search action',
      };
    }

    const lowerQuery = query.toLowerCase();
    const matches: Array<{ noteId: string; title: string; content: string }> = [];

    for (const [, entry] of this.notes) {
      if (entry.userId !== context.userId) {
        continue;
      }

      if (
        entry.title.toLowerCase().includes(lowerQuery) ||
        entry.content.toLowerCase().includes(lowerQuery)
      ) {
        matches.push({
          noteId: entry.noteId,
          title: entry.title,
          content: entry.content,
        });
      }
    }

    return {
      success: true,
      data: matches,
      display:
        matches.length === 0
          ? `No notes matching "${query}".`
          : `Found ${matches.length} note(s):\n${matches.map((n) => `- ${n.noteId}: "${n.title}"`).join('\n')}`,
    };
  }

  private deleteNote(input: Record<string, unknown>): SkillResult {
    const noteId = input.noteId as string | undefined;

    if (!noteId || typeof noteId !== 'string') {
      return {
        success: false,
        error: 'Missing required field "noteId" for delete action',
      };
    }

    const entry = this.notes.get(noteId);

    if (!entry) {
      return {
        success: false,
        error: `Note "${noteId}" not found`,
      };
    }

    this.notes.delete(noteId);

    return {
      success: true,
      data: { noteId },
      display: `Note "${noteId}" deleted.`,
    };
  }
}
