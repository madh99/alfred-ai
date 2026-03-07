import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { MicrosoftTodoConfig } from '@alfred/types';

export class MicrosoftTodoSkill extends Skill {
  private accessToken = '';

  readonly metadata: SkillMetadata = {
    name: 'microsoft_todo',
    description: 'Manage Microsoft To Do lists and tasks — list, create, complete, update and delete tasks across all lists.',
    version: '1.0.0',
    riskLevel: 'write',
    category: 'productivity',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list_lists', 'list_tasks', 'add_task', 'complete_task', 'uncomplete_task', 'delete_task', 'update_task', 'create_list'],
          description: 'Action to perform.',
        },
        listId: { type: 'string', description: 'To Do list ID. Either listId or list (display name) is required for task actions.' },
        list: { type: 'string', description: 'To Do list display name (resolved to listId automatically). E.g. "Einkaufsliste".' },
        taskId: { type: 'string', description: 'Task ID (required for complete/uncomplete/delete/update).' },
        title: { type: 'string', description: 'Task or list title (required for add_task, create_list; optional for update_task).' },
        body: { type: 'string', description: 'Task body/notes.' },
        dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format.' },
        importance: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task importance.' },
        includeCompleted: { type: 'boolean', description: 'Include completed tasks in list_tasks (default: false).' },
      },
    },
  };

  constructor(private readonly config: MicrosoftTodoConfig) {
    super();
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    try {
      switch (action) {
        case 'list_lists': return await this.listLists();
        case 'list_tasks': return await this.listTasks(input);
        case 'add_task': return await this.addTask(input);
        case 'complete_task': return await this.completeTask(input);
        case 'uncomplete_task': return await this.uncompleteTask(input);
        case 'delete_task': return await this.deleteTask(input);
        case 'update_task': return await this.updateTask(input);
        case 'create_list': return await this.createList(input);
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Graph API helpers ─────────────────────────────────────────────

  private async refreshAccessToken(): Promise<void> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Tasks.ReadWrite offline_access',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async graphRequest(path: string, options: RequestInit = {}): Promise<any> {
    const doFetch = () =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

    let res = await doFetch();

    if (res.status === 401) {
      await this.refreshAccessToken();
      res = await doFetch();
      if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    } else if (!res.ok) {
      throw new Error(`Graph API error: ${res.status}`);
    }

    if (res.status === 204) return undefined;
    return res.json();
  }

  // ── List name → ID resolution ─────────────────────────────────────

  private async resolveListId(input: Record<string, unknown>): Promise<string> {
    if (input.listId) return input.listId as string;
    if (!input.list) throw new Error('Either listId or list (display name) is required.');

    const listName = (input.list as string).toLowerCase();
    const data = await this.graphRequest('/me/todo/lists');
    const lists = (data.value ?? []) as Array<{ id: string; displayName: string }>;
    const match = lists.find(l => l.displayName.toLowerCase() === listName);
    if (!match) {
      const available = lists.map(l => l.displayName).join(', ');
      throw new Error(`List "${input.list}" not found. Available lists: ${available}`);
    }
    return match.id;
  }

  // ── Actions ───────────────────────────────────────────────────────

  private async listLists(): Promise<SkillResult> {
    const data = await this.graphRequest('/me/todo/lists');
    const lists = (data.value ?? []) as Array<{ id: string; displayName: string; isOwner: boolean; wellknownListName?: string }>;

    const display = lists.map(l => `• **${l.displayName}**${l.wellknownListName === 'defaultList' ? ' (Standard)' : ''} [listId=${l.id}]`).join('\n');

    return { success: true, data: lists, display: display || 'Keine Listen gefunden.' };
  }

  private async listTasks(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    const includeCompleted = input.includeCompleted === true;

    let path = `/me/todo/lists/${listId}/tasks`;
    if (!includeCompleted) {
      path += `?$filter=status ne 'completed'`;
    }

    const data = await this.graphRequest(path);
    const tasks = (data.value ?? []) as Array<{
      id: string; title: string; status: string;
      importance: string; body?: { content: string };
      dueDateTime?: { dateTime: string };
    }>;

    const lines = tasks.map(t => {
      const check = t.status === 'completed' ? '☑' : '☐';
      const imp = t.importance === 'high' ? ' ❗' : '';
      const due = t.dueDateTime ? ` (fällig: ${t.dueDateTime.dateTime.slice(0, 10)})` : '';
      return `${check} ${t.title}${imp}${due} [taskId=${t.id}]`;
    });

    return {
      success: true,
      data: tasks,
      display: lines.length > 0
        ? `listId=${listId}\n${lines.join('\n')}`
        : 'Keine Aufgaben in dieser Liste.',
    };
  }

  private async addTask(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    if (!input.title) return { success: false, error: 'title is required for add_task.' };

    const task: Record<string, unknown> = { title: input.title };
    if (input.body) task.body = { content: input.body as string, contentType: 'text' };
    if (input.dueDate) task.dueDateTime = { dateTime: `${input.dueDate}T00:00:00`, timeZone: 'UTC' };
    if (input.importance) task.importance = input.importance;

    const created = await this.graphRequest(`/me/todo/lists/${listId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(task),
    });

    return { success: true, data: created, display: `Aufgabe „${input.title}" hinzugefügt.` };
  }

  private async completeTask(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    await this.graphRequest(`/me/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    return { success: true, display: 'Aufgabe als erledigt markiert.' };
  }

  private async uncompleteTask(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    await this.graphRequest(`/me/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'notStarted' }),
    });

    return { success: true, display: 'Aufgabe als nicht erledigt markiert.' };
  }

  private async deleteTask(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    await this.graphRequest(`/me/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'DELETE',
    });

    return { success: true, display: 'Aufgabe gelöscht.' };
  }

  private async updateTask(input: Record<string, unknown>): Promise<SkillResult> {
    const listId = await this.resolveListId(input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    const patch: Record<string, unknown> = {};
    if (input.title) patch.title = input.title;
    if (input.body) patch.body = { content: input.body as string, contentType: 'text' };
    if (input.dueDate) patch.dueDateTime = { dateTime: `${input.dueDate}T00:00:00`, timeZone: 'UTC' };
    if (input.importance) patch.importance = input.importance;

    if (Object.keys(patch).length === 0) {
      return { success: false, error: 'Nothing to update — provide title, body, dueDate, or importance.' };
    }

    const updated = await this.graphRequest(`/me/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    return { success: true, data: updated, display: 'Aufgabe aktualisiert.' };
  }

  private async createList(input: Record<string, unknown>): Promise<SkillResult> {
    if (!input.title) return { success: false, error: 'title is required for create_list.' };

    const created = await this.graphRequest('/me/todo/lists', {
      method: 'POST',
      body: JSON.stringify({ displayName: input.title }),
    });

    return { success: true, data: created, display: `Liste „${input.title}" erstellt.` };
  }
}
