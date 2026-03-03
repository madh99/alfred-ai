import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { TodoRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type TodoAction = 'add' | 'list' | 'complete' | 'uncomplete' | 'delete' | 'lists' | 'clear';

export class TodoSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'todo',
    description:
      'Manage todo lists with multiple named lists. ' +
      'Actions: add, list, complete, uncomplete, delete, lists, clear.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'complete', 'uncomplete', 'delete', 'lists', 'clear'],
          description: 'The todo action to perform',
        },
        title: {
          type: 'string',
          description: 'The todo title (required for add)',
        },
        list: {
          type: 'string',
          description: 'The list name (default: "default")',
        },
        description: {
          type: 'string',
          description: 'Optional description for the todo',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Priority level (default: "normal")',
        },
        dueDate: {
          type: 'string',
          description: 'Due date for the todo (ISO string)',
        },
        todoId: {
          type: 'string',
          description: 'The ID of the todo (required for complete, uncomplete, delete)',
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed todos in list output (default: false)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly todoRepo: TodoRepository) {
    super();
  }

  private effectiveUserId(context: SkillContext): string {
    return context.masterUserId ?? context.userId;
  }

  private allUserIds(context: SkillContext): string[] {
    const set = new Set<string>();
    set.add(this.effectiveUserId(context));
    set.add(context.userId);
    if (context.linkedPlatformUserIds) {
      for (const id of context.linkedPlatformUserIds) set.add(id);
    }
    return [...set];
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as TodoAction;

    switch (action) {
      case 'add':
        return this.addTodo(input, context);
      case 'list':
        return this.listTodos(input, context);
      case 'complete':
        return this.completeTodo(input, context);
      case 'uncomplete':
        return this.uncompleteTodo(input, context);
      case 'delete':
        return this.deleteTodo(input, context);
      case 'lists':
        return this.showLists(context);
      case 'clear':
        return this.clearCompleted(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: add, list, complete, uncomplete, delete, lists, clear`,
        };
    }
  }

  private addTodo(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const title = input.title as string | undefined;

    if (!title || typeof title !== 'string') {
      return { success: false, error: 'Missing required field "title" for add action' };
    }

    const list = (input.list as string | undefined) ?? 'default';
    const description = input.description as string | undefined;
    const priority = input.priority as string | undefined;
    const dueDate = input.dueDate as string | undefined;

    const entry = this.todoRepo.add(this.effectiveUserId(context), title, {
      list,
      description,
      priority,
      dueDate,
    });

    return {
      success: true,
      data: { todoId: entry.id, title: entry.title, list: entry.list },
      display: `Todo added: "${title}"`,
    };
  }

  private listTodos(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const list = input.list as string | undefined;
    const includeCompleted = (input.includeCompleted as boolean | undefined) ?? false;

    const seen = new Set<string>();
    const todos: ReturnType<typeof this.todoRepo.list> = [];
    for (const uid of this.allUserIds(context)) {
      for (const t of this.todoRepo.list(uid, list, includeCompleted)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          todos.push(t);
        }
      }
    }

    if (todos.length === 0) {
      return { success: true, data: [], display: 'No todos found.' };
    }

    const header = '| | Priority | Title | Due | ID |\n|---|---|---|---|---|';
    const rows = todos
      .map(t => {
        const check = t.completed ? '\u2611' : '\u2610';
        const due = t.dueDate ?? '';
        const shortId = t.id.slice(0, 8);
        return `| ${check} | ${t.priority} | ${t.title} | ${due} | ${shortId} |`;
      })
      .join('\n');

    return {
      success: true,
      data: todos,
      display: `${todos.length} todo(s):\n${header}\n${rows}`,
    };
  }

  private completeTodo(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for complete action' };
    }

    const todo = this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = this.allUserIds(context);
    if (!userIds.includes(todo.userId)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const completed = this.todoRepo.complete(todoId);
    if (!completed) {
      return { success: false, error: `Todo "${todoId}" is already completed` };
    }

    return { success: true, data: { todoId }, display: 'Todo completed.' };
  }

  private uncompleteTodo(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for uncomplete action' };
    }

    const todo = this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = this.allUserIds(context);
    if (!userIds.includes(todo.userId)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const reopened = this.todoRepo.uncomplete(todoId);
    if (!reopened) {
      return { success: false, error: `Todo "${todoId}" is not completed` };
    }

    return { success: true, data: { todoId }, display: 'Todo reopened.' };
  }

  private deleteTodo(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for delete action' };
    }

    const todo = this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = this.allUserIds(context);
    if (!userIds.includes(todo.userId)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const deleted = this.todoRepo.delete(todoId);
    if (!deleted) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    return { success: true, data: { todoId }, display: 'Todo deleted.' };
  }

  private showLists(context: SkillContext): SkillResult {
    const merged = new Map<string, { open: number; completed: number; total: number }>();

    for (const uid of this.allUserIds(context)) {
      for (const entry of this.todoRepo.getLists(uid)) {
        const existing = merged.get(entry.list);
        if (existing) {
          existing.open += entry.open;
          existing.completed += entry.completed;
          existing.total += entry.total;
        } else {
          merged.set(entry.list, { open: entry.open, completed: entry.completed, total: entry.total });
        }
      }
    }

    if (merged.size === 0) {
      return { success: true, data: [], display: 'No todo lists found.' };
    }

    const lists = [...merged.entries()].map(([list, counts]) => ({
      list,
      ...counts,
    }));

    const header = '| List | Open | Completed | Total |\n|---|---|---|---|';
    const rows = lists
      .map(l => `| ${l.list} | ${l.open} | ${l.completed} | ${l.total} |`)
      .join('\n');

    return {
      success: true,
      data: lists,
      display: `${lists.length} list(s):\n${header}\n${rows}`,
    };
  }

  private clearCompleted(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const list = input.list as string | undefined;

    const cleared = this.todoRepo.clearCompleted(this.effectiveUserId(context), list);

    return {
      success: true,
      data: { cleared },
      display: `Cleared ${cleared} completed todo(s).`,
    };
  }
}
