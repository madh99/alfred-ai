import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { NoteRepository, SharedResourceRepository } from '@alfred/storage';
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

  private sharedResourceRepo?: SharedResourceRepository;

  constructor(private readonly noteRepo: NoteRepository) {
    super();
  }

  /** Resolve note IDs shared with the current alfred user. */
  private async getSharedNoteIds(context: SkillContext): Promise<string[]> {
    if (!this.sharedResourceRepo || !context.alfredUserId) return [];
    try {
      const shared = await this.sharedResourceRepo.getSharedWith(context.alfredUserId);
      return shared.filter(s => s.resourceType === 'note').map(s => s.resourceId);
    } catch { return []; }
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

  private async saveNote(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const title = input.title as string | undefined;
    const content = input.content as string | undefined;

    if (!title || typeof title !== 'string') {
      return { success: false, error: 'Missing required field "title" for save action' };
    }
    if (!content || typeof content !== 'string') {
      return { success: false, error: 'Missing required field "content" for save action' };
    }

    const entry = await this.noteRepo.save(effectiveUserId(context), title, content);

    return {
      success: true,
      data: { noteId: entry.id, title: entry.title },
      display: `Note saved: "${title}"`,
    };
  }

  private async listNotes(context: SkillContext): Promise<SkillResult> {
    const seen = new Set<string>();
    const notes: Awaited<ReturnType<typeof this.noteRepo.list>> = [];
    for (const uid of allUserIds(context)) {
      for (const n of await this.noteRepo.list(uid)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          notes.push(n);
        }
      }
    }

    // Include shared notes
    const sharedIds = await this.getSharedNoteIds(context);
    const sharedNoteIds = new Set<string>();
    for (const id of sharedIds) {
      if (!seen.has(id)) {
        const note = await this.noteRepo.getById(id);
        if (note) {
          seen.add(note.id);
          sharedNoteIds.add(note.id);
          notes.push(note);
        }
      }
    }

    if (notes.length === 0) {
      return { success: true, data: [], display: 'No notes found.' };
    }

    const display = notes
      .map(n => {
        const shared = sharedNoteIds.has(n.id) ? ' (shared)' : '';
        return `- **${n.title}**${shared} (${n.id.slice(0, 8)}…)\n  ${n.content.slice(0, 100)}${n.content.length > 100 ? '…' : ''}`;
      })
      .join('\n');

    return { success: true, data: notes, display: `${notes.length} note(s):\n${display}` };
  }

  private async searchNotes(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const query = input.query as string | undefined;

    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required field "query" for search action' };
    }

    const seen = new Set<string>();
    const matches: Awaited<ReturnType<typeof this.noteRepo.search>> = [];
    for (const uid of allUserIds(context)) {
      for (const n of await this.noteRepo.search(uid, query)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          matches.push(n);
        }
      }
    }

    // Include shared notes matching the query
    const sharedIds = await this.getSharedNoteIds(context);
    const sharedNoteIds = new Set<string>();
    const lowerQuery = query.toLowerCase();
    for (const id of sharedIds) {
      if (!seen.has(id)) {
        const note = await this.noteRepo.getById(id);
        if (note && (note.title.toLowerCase().includes(lowerQuery) || note.content.toLowerCase().includes(lowerQuery))) {
          seen.add(note.id);
          sharedNoteIds.add(note.id);
          matches.push(note);
        }
      }
    }

    if (matches.length === 0) {
      return { success: true, data: [], display: `No notes matching "${query}".` };
    }

    const display = matches
      .map(n => {
        const shared = sharedNoteIds.has(n.id) ? ' (shared)' : '';
        return `- **${n.title}**${shared} (${n.id.slice(0, 8)}…)\n  ${n.content.slice(0, 100)}${n.content.length > 100 ? '…' : ''}`;
      })
      .join('\n');

    return { success: true, data: matches, display: `Found ${matches.length} note(s):\n${display}` };
  }

  private async deleteNote(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const noteId = input.noteId as string | undefined;

    if (!noteId || typeof noteId !== 'string') {
      return { success: false, error: 'Missing required field "noteId" for delete action' };
    }

    // Verify ownership before deleting (check all linked user IDs)
    const note = await this.noteRepo.getById(noteId);
    if (!note) {
      return { success: false, error: `Note "${noteId}" not found` };
    }
    const userIds = allUserIds(context);
    if (!userIds.includes(note.userId)) {
      return { success: false, error: `Note "${noteId}" not found` };
    }

    const deleted = await this.noteRepo.delete(noteId);

    if (!deleted) {
      return { success: false, error: `Note "${noteId}" not found` };
    }

    return { success: true, data: { noteId }, display: `Note deleted.` };
  }
}
