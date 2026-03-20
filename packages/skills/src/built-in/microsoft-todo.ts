import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { MicrosoftTodoConfig } from '@alfred/types';

export class MicrosoftTodoSkill extends Skill {
  /** Per-account access tokens, keyed by account name. */
  private accessTokens = new Map<string, string>();

  readonly metadata: SkillMetadata;

  private readonly configs: Map<string, MicrosoftTodoConfig>;
  private readonly defaultAccount: string;

  /** Per-request override for user-specific configs (set in execute, cleared in finally). */
  private activeConfigs?: Map<string, MicrosoftTodoConfig>;
  private mergedConfigs?: Map<string, MicrosoftTodoConfig>;

  constructor(configs?: Map<string, MicrosoftTodoConfig> | MicrosoftTodoConfig) {
    super();

    if (configs instanceof Map) {
      this.configs = configs;
    } else if (configs) {
      this.configs = new Map([['default', configs]]);
    } else {
      this.configs = new Map();
    }

    this.defaultAccount = [...this.configs.keys()][0] ?? 'default';

    const accountProp = {
      account: {
        type: 'string' as const,
        description: 'Microsoft Todo account name. Use list_accounts to see available accounts.',
      },
    };

    const description = 'Manage Microsoft To Do lists and tasks — list, create, complete, update and delete tasks across all lists. Use "list_accounts" to see available todo accounts.';

    this.metadata = {
      name: 'microsoft_todo',
      description,
      version: '2.0.0',
      riskLevel: 'write',
      category: 'productivity',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list_lists', 'list_tasks', 'add_task', 'complete_task', 'uncomplete_task', 'delete_task', 'update_task', 'create_list', 'list_accounts'],
            description: 'Action to perform.',
          },
          ...accountProp,
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
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    // Resolve per-user todo configs if available
    const userConfigs = await this.resolveUserConfigs(context);
    this.activeConfigs = userConfigs ?? undefined;

    try {
      // Multi-user: non-admin users must have their own todo config, no fallback to global
      let cfgs: Map<string, MicrosoftTodoConfig>;
      if (this.activeConfigs) {
        if (context.userRole === 'admin' || !context.alfredUserId) {
          cfgs = new Map([...this.configs, ...this.activeConfigs]);
        } else {
          cfgs = this.activeConfigs;
        }
      } else {
        cfgs = (context.userRole === 'admin' || !context.alfredUserId) ? this.configs : new Map();
      }
      this.mergedConfigs = cfgs;
      if (cfgs.size === 0) {
        return { success: false, error: 'Microsoft Todo ist nicht konfiguriert. Nutze "setup_service" um Microsoft Todo zu verbinden.' };
      }

      const action = input.action as string;

      try {
        switch (action) {
          case 'list_lists': return await this.listLists(input);
          case 'list_tasks': return await this.listTasks(input);
          case 'add_task': return await this.addTask(input);
          case 'complete_task': return await this.completeTask(input);
          case 'uncomplete_task': return await this.uncompleteTask(input);
          case 'delete_task': return await this.deleteTask(input);
          case 'update_task': return await this.updateTask(input);
          case 'create_list': return await this.createList(input);
          case 'list_accounts': return this.handleListAccounts(cfgs);
          default:
            return { success: false, error: `Unknown action: ${action}` };
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      this.activeConfigs = undefined;
      this.mergedConfigs = undefined;
    }
  }

  // ── Config Resolution ───────────────────────────────────────────

  /**
   * Resolve per-user todo configs from UserServiceResolver.
   * Returns null if no per-user config is available (fall back to global).
   */
  private async resolveUserConfigs(context: SkillContext): Promise<Map<string, MicrosoftTodoConfig> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'todo');
    if (services.length === 0) return null;

    const cfgs = new Map<string, MicrosoftTodoConfig>();
    for (const svc of services) {
      if (svc.config && (svc.config as any).clientId) {
        cfgs.set(svc.serviceName, svc.config as unknown as MicrosoftTodoConfig);
      }
    }
    return cfgs.size > 0 ? cfgs : null;
  }

  private resolveConfig(input: Record<string, unknown>): { cfg: MicrosoftTodoConfig; account: string } | SkillResult {
    const cfgs = this.mergedConfigs ?? this.activeConfigs ?? this.configs;
    const accountNames = [...cfgs.keys()];
    const defaultAccount = accountNames[0] ?? 'default';
    const account = (input.account as string) ?? defaultAccount;
    const cfg = cfgs.get(account);
    if (!cfg) {
      return {
        success: false,
        error: `Unbekannter Todo-Account "${account}". Verfügbar: ${accountNames.join(', ')}`,
      };
    }
    return { cfg, account };
  }

  private accountLabel(account: string, text: string): string {
    const cfgs = this.mergedConfigs ?? this.activeConfigs ?? this.configs;
    return cfgs.size > 1 ? `[${account}] ${text}` : text;
  }

  private handleListAccounts(cfgs: Map<string, MicrosoftTodoConfig>): SkillResult {
    const names = [...cfgs.keys()];
    if (names.length === 0) {
      return { success: true, data: { accounts: [] }, display: 'Keine Todo-Accounts konfiguriert.\nNutze "setup_service" um Microsoft Todo zu verbinden.' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfügbare Todo-Accounts:\n${names.map((n, i) => `${i === 0 ? '• ' + n + ' (Standard)' : '• ' + n}`).join('\n')}`,
    };
  }

  // ── Graph API helpers ─────────────────────────────────────────────

  /** Graph API user path. '/me' for own todos, '/users/{email}' for shared. */
  private getUserPath(cfg: MicrosoftTodoConfig): string {
    return (cfg as any).sharedUser ? `/users/${(cfg as any).sharedUser}` : '/me';
  }

  private async refreshAccessToken(cfg: MicrosoftTodoConfig, account: string): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
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
    this.accessTokens.set(account, data.access_token);
    return data.access_token;
  }

  private async getAccessToken(cfg: MicrosoftTodoConfig, account: string): Promise<string> {
    const existing = this.accessTokens.get(account);
    if (existing) return existing;
    return this.refreshAccessToken(cfg, account);
  }

  private async graphRequest(cfg: MicrosoftTodoConfig, account: string, path: string, options: RequestInit = {}): Promise<any> {
    const token = await this.getAccessToken(cfg, account);

    const doFetch = (t: string) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${t}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

    let res = await doFetch(token);

    if (res.status === 401) {
      const newToken = await this.refreshAccessToken(cfg, account);
      res = await doFetch(newToken);
      if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    } else if (!res.ok) {
      throw new Error(`Graph API error: ${res.status}`);
    }

    if (res.status === 204) return undefined;
    return res.json();
  }

  // ── List name -> ID resolution ─────────────────────────────────────

  private async resolveListId(cfg: MicrosoftTodoConfig, account: string, input: Record<string, unknown>): Promise<string> {
    if (input.listId) return input.listId as string;

    const userPath = this.getUserPath(cfg);
    const data = await this.graphRequest(cfg, account, `${userPath}/todo/lists`);
    const lists = (data.value ?? []) as Array<{ id: string; displayName: string; wellknownListName?: string }>;

    if (input.list) {
      const listName = (input.list as string).toLowerCase();
      const match = lists.find(l => l.displayName.toLowerCase() === listName);
      if (!match) {
        const available = lists.map(l => l.displayName).join(', ');
        throw new Error(`List "${input.list}" not found. Available lists: ${available}`);
      }
      return match.id;
    }

    // Fall back to default list (Aufgaben / Tasks)
    const defaultList = lists.find(l => l.wellknownListName === 'defaultList');
    if (defaultList) return defaultList.id;
    if (lists.length > 0) return lists[0].id;
    throw new Error('No To Do lists found.');
  }

  // ── Actions ───────────────────────────────────────────────────────

  private async listLists(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const userPath = this.getUserPath(cfg);
    const data = await this.graphRequest(cfg, account, `${userPath}/todo/lists`);
    const lists = (data.value ?? []) as Array<{ id: string; displayName: string; isOwner: boolean; wellknownListName?: string }>;

    const display = lists.map(l => `• **${l.displayName}**${l.wellknownListName === 'defaultList' ? ' (Standard)' : ''} [listId=${l.id}]`).join('\n');

    return { success: true, data: lists, display: this.accountLabel(account, display || 'Keine Listen gefunden.') };
  }

  private async listTasks(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    const includeCompleted = input.includeCompleted === true;

    const userPath = this.getUserPath(cfg);
    let path = `${userPath}/todo/lists/${listId}/tasks`;
    if (!includeCompleted) {
      path += `?$filter=status ne 'completed'`;
    }

    const data = await this.graphRequest(cfg, account, path);
    const tasks = (data.value ?? []) as Array<{
      id: string; title: string; status: string;
      importance: string; body?: { content: string };
      dueDateTime?: { dateTime: string };
    }>;

    const lines = tasks.map(t => {
      const check = t.status === 'completed' ? '\u2611' : '\u2610';
      const imp = t.importance === 'high' ? ' \u2757' : '';
      const due = t.dueDateTime ? ` (fällig: ${t.dueDateTime.dateTime.slice(0, 10)})` : '';
      return `${check} ${t.title}${imp}${due} [taskId=${t.id}]`;
    });

    return {
      success: true,
      data: tasks,
      display: this.accountLabel(account, lines.length > 0
        ? `listId=${listId}\n${lines.join('\n')}`
        : 'Keine Aufgaben in dieser Liste.'),
    };
  }

  private async addTask(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    if (!input.title) return { success: false, error: 'title is required for add_task.' };

    const userPath = this.getUserPath(cfg);
    const task: Record<string, unknown> = { title: input.title };
    if (input.body) task.body = { content: input.body as string, contentType: 'text' };
    if (input.dueDate) task.dueDateTime = { dateTime: `${input.dueDate}T00:00:00`, timeZone: 'UTC' };
    if (input.importance) task.importance = input.importance;

    const created = await this.graphRequest(cfg, account, `${userPath}/todo/lists/${listId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(task),
    });

    return { success: true, data: created, display: this.accountLabel(account, `Aufgabe \u201E${input.title}\u201C hinzugefügt.`) };
  }

  private async completeTask(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    const userPath = this.getUserPath(cfg);
    await this.graphRequest(cfg, account, `${userPath}/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    return { success: true, display: this.accountLabel(account, 'Aufgabe als erledigt markiert.') };
  }

  private async uncompleteTask(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    const userPath = this.getUserPath(cfg);
    await this.graphRequest(cfg, account, `${userPath}/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'notStarted' }),
    });

    return { success: true, display: this.accountLabel(account, 'Aufgabe als nicht erledigt markiert.') };
  }

  private async deleteTask(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    const userPath = this.getUserPath(cfg);
    await this.graphRequest(cfg, account, `${userPath}/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'DELETE',
    });

    return { success: true, display: this.accountLabel(account, 'Aufgabe gelöscht.') };
  }

  private async updateTask(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const listId = await this.resolveListId(cfg, account, input);
    if (!input.taskId) return { success: false, error: 'taskId is required.' };

    const patch: Record<string, unknown> = {};
    if (input.title) patch.title = input.title;
    if (input.body) patch.body = { content: input.body as string, contentType: 'text' };
    if (input.dueDate) patch.dueDateTime = { dateTime: `${input.dueDate}T00:00:00`, timeZone: 'UTC' };
    if (input.importance) patch.importance = input.importance;

    if (Object.keys(patch).length === 0) {
      return { success: false, error: 'Nothing to update — provide title, body, dueDate, or importance.' };
    }

    const userPath = this.getUserPath(cfg);
    const updated = await this.graphRequest(cfg, account, `${userPath}/todo/lists/${listId}/tasks/${input.taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    return { success: true, data: updated, display: this.accountLabel(account, 'Aufgabe aktualisiert.') };
  }

  private async createList(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.title) return { success: false, error: 'title is required for create_list.' };

    const userPath = this.getUserPath(cfg);
    const created = await this.graphRequest(cfg, account, `${userPath}/todo/lists`, {
      method: 'POST',
      body: JSON.stringify({ displayName: input.title }),
    });

    return { success: true, data: created, display: this.accountLabel(account, `Liste \u201E${input.title}\u201C erstellt.`) };
  }
}
