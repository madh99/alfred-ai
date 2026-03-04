import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { NoteRepository } from '@alfred/storage';
import { Skill } from '../skill.js';
import { effectiveUserId, allUserIds } from '../user-utils.js';

type NoteAction = 'save' | 'list' | 'search' | 'delete';

export class NoteSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'note',
    category: 'productivity',
    description:
      'Save, list, search, or delete persistent notes (stored in SQLite). ' +
      'Use when the user wants to write down or retrieve text notes, lists, or ideas.',
    riskLevel: 'write',
    version: '2.0.0',
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

  constructor(private readonly noteRepo: NoteRepository) {
    super();
  }

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
        return this.deleteNote(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: save, list, search, delete`,
        };
    }
  }

  private saveNote(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const title = input.title as string | undefined;
    const content = input.content as string | undefined;

    if (!title || typeof title !== 'string') {
      return { success: false, error: 'Missing required field "title" for save action' };
    }
    if (!content || typeof content !== 'string') {
      return { success: false, error: 'Missing required field "content" for save action' };
    }

    const entry = this.noteRepo.save(effectiveUserId(context), title, content);

    return {
      success: true,
      data: { noteId: entry.id, title: entry.title },
      display: `Note saved: "${title}"`,
    };
  }

  private listNotes(context: SkillContext): SkillResult {
    const seen = new Set<string>();
    const notes: ReturnType<typeof this.noteRepo.list> = [];
    for (const uid of allUserIds(context)) {
      for (const n of this.noteRepo.list(uid)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          notes.push(n);
        }
      }
    }

    if (notes.length === 0) {
      return { success: true, data: [], display: 'No notes found.' };
    }

    const display = notes
      .map(n => `- **${n.title}** (${n.id.slice(0, 8)}…)\n  ${n.content.slice(0, 100)}${n.content.length > 100 ? '…' : ''}`)
      .join('\n');

    return { success: true, data: notes, display: `${notes.length} note(s):\n${display}` };
  }

  private searchNotes(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const query = input.query as string | undefined;

    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required field "query" for search action' };
    }

    const seen = new Set<string>();
    const matches: ReturnType<typeof this.noteRepo.search> = [];
    for (const uid of allUserIds(context)) {
      for (const n of this.noteRepo.search(uid, query)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          matches.push(n);
        }
      }
    }

    if (matches.length === 0) {
      return { success: true, data: [], display: `No notes matching "${query}".` };
    }

    const display = matches
      .map(n => `- **${n.title}** (${n.id.slice(0, 8)}…)\n  ${n.content.slice(0, 100)}${n.content.length > 100 ? '…' : ''}`)
      .join('\n');

    return { success: true, data: matches, display: `Found ${matches.length} note(s):\n${display}` };
  }

  private deleteNote(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const noteId = input.noteId as string | undefined;

    if (!noteId || typeof noteId !== 'string') {
      return { success: false, error: 'Missing required field "noteId" for delete action' };
    }

    // Verify ownership before deleting (check all linked user IDs)
    const note = this.noteRepo.getById(noteId);
    if (!note) {
      return { success: false, error: `Note "${noteId}" not found` };
    }
    const userIds = allUserIds(context);
    if (!userIds.includes(note.userId)) {
      return { success: false, error: `Note "${noteId}" not found` };
    }

    const deleted = this.noteRepo.delete(noteId);

    if (!deleted) {
      return { success: false, error: `Note "${noteId}" not found` };
    }

    return { success: true, data: { noteId }, display: `Note deleted.` };
  }
}
