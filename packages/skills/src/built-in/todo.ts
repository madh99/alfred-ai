import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { TodoRepository, SharedResourceRepository } from '@alfred/storage';
import { Skill } from '../skill.js';
import { effectiveUserId, allUserIds } from '../user-utils.js';

type TodoAction = 'add' | 'list' | 'complete' | 'uncomplete' | 'delete' | 'lists' | 'clear';

export class TodoSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'todo',
    category: 'productivity',
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

  private sharedResourceRepo?: SharedResourceRepository;

  constructor(private readonly todoRepo: TodoRepository) {
    super();
  }

  /** Resolve shared todo list names for the current alfred user. */
  private async getSharedTodoLists(context: SkillContext): Promise<string[]> {
    if (!this.sharedResourceRepo || !context.alfredUserId) return [];
    try {
      const shared = await this.sharedResourceRepo.getSharedWith(context.alfredUserId);
      return shared.filter(s => s.resourceType === 'todo_list').map(s => s.resourceId);
    } catch { return []; }
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

  private async addTodo(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const title = input.title as string | undefined;

    if (!title || typeof title !== 'string') {
      return { success: false, error: 'Missing required field "title" for add action' };
    }

    const list = (input.list as string | undefined) ?? 'default';
    const description = input.description as string | undefined;
    const priority = input.priority as string | undefined;
    const dueDate = input.dueDate as string | undefined;

    const entry = await this.todoRepo.add(effectiveUserId(context), title, {
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

  private async listTodos(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const list = input.list as string | undefined;
    const includeCompleted = (input.includeCompleted as boolean | undefined) ?? false;

    const seen = new Set<string>();
    const todos: Awaited<ReturnType<typeof this.todoRepo.list>> = [];
    for (const uid of allUserIds(context)) {
      for (const t of await this.todoRepo.list(uid, list, includeCompleted)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          todos.push(t);
        }
      }
    }

    // Include todos from shared lists
    const sharedLists = await this.getSharedTodoLists(context);
    const sharedTodoIds = new Set<string>();
    for (const sharedList of sharedLists) {
      // If a specific list is requested, only include shared todos from that list
      if (list && sharedList !== list) continue;
      for (const t of await this.todoRepo.listByListName(sharedList, includeCompleted)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          sharedTodoIds.add(t.id);
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
        const shared = sharedTodoIds.has(t.id) ? ' (shared)' : '';
        return `| ${check} | ${t.priority} | ${t.title}${shared} | ${due} | ${t.id} |`;
      })
      .join('\n');

    return {
      success: true,
      data: todos,
      display: `${todos.length} todo(s):\n${header}\n${rows}`,
    };
  }

  private async completeTodo(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for complete action' };
    }

    const todo = await this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = allUserIds(context);
    const sharedLists = await this.getSharedTodoLists(context);
    if (!userIds.includes(todo.userId) && !sharedLists.includes(todo.list)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const completed = await this.todoRepo.complete(todoId);
    if (!completed) {
      return { success: false, error: `Todo "${todoId}" is already completed` };
    }

    return { success: true, data: { todoId }, display: 'Todo completed.' };
  }

  private async uncompleteTodo(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for uncomplete action' };
    }

    const todo = await this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = allUserIds(context);
    const sharedLists = await this.getSharedTodoLists(context);
    if (!userIds.includes(todo.userId) && !sharedLists.includes(todo.list)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const reopened = await this.todoRepo.uncomplete(todoId);
    if (!reopened) {
      return { success: false, error: `Todo "${todoId}" is not completed` };
    }

    return { success: true, data: { todoId }, display: 'Todo reopened.' };
  }

  private async deleteTodo(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const todoId = input.todoId as string | undefined;

    if (!todoId || typeof todoId !== 'string') {
      return { success: false, error: 'Missing required field "todoId" for delete action' };
    }

    const todo = await this.todoRepo.getById(todoId);
    if (!todo) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }
    const userIds = allUserIds(context);
    if (!userIds.includes(todo.userId)) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    const deleted = await this.todoRepo.delete(todoId);
    if (!deleted) {
      return { success: false, error: `Todo "${todoId}" not found` };
    }

    return { success: true, data: { todoId }, display: 'Todo deleted.' };
  }

  private async showLists(context: SkillContext): Promise<SkillResult> {
    const merged = new Map<string, { open: number; completed: number; total: number; shared?: boolean }>();

    for (const uid of allUserIds(context)) {
      for (const entry of await this.todoRepo.getLists(uid)) {
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

    // Include shared lists
    const sharedLists = await this.getSharedTodoLists(context);
    for (const sharedList of sharedLists) {
      if (!merged.has(sharedList)) {
        const todos = await this.todoRepo.listByListName(sharedList, true);
        const open = todos.filter(t => !t.completed).length;
        const completed = todos.filter(t => t.completed).length;
        merged.set(sharedList, { open, completed, total: todos.length, shared: true });
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
      .map(l => {
        const shared = (l as any).shared ? ' (shared)' : '';
        return `| ${l.list}${shared} | ${l.open} | ${l.completed} | ${l.total} |`;
      })
      .join('\n');

    return {
      success: true,
      data: lists,
      display: `${lists.length} list(s):\n${header}\n${rows}`,
    };
  }

  private async clearCompleted(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const list = input.list as string | undefined;

    const cleared = await this.todoRepo.clearCompleted(effectiveUserId(context), list);

    return {
      success: true,
      data: { cleared },
      display: `Cleared ${cleared} completed todo(s).`,
    };
  }
}
