import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { MicrosoftTodoConfig } from '@alfred/types';

export class OneDriveSkill extends Skill {
  /** Per-account access tokens, keyed by account name. */
  private accessTokens = new Map<string, string>();

  readonly metadata: SkillMetadata;

  private readonly configs: Map<string, MicrosoftTodoConfig>;
  private readonly defaultAccount: string;

  /** Per-request override for user-specific configs (set in execute, cleared in finally). */
  private activeConfigs?: Map<string, MicrosoftTodoConfig>;
  private mergedConfigs?: Map<string, MicrosoftTodoConfig>;

  /** Cache for scope check results (account -> { ok, ts }). */
  private scopeCache = new Map<string, { ok: boolean; ts: number }>();
  private static readonly SCOPE_TTL = 30 * 60_000; // 30 min

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
        description: 'OneDrive account name. Use list_accounts to see available accounts.',
      },
    };

    this.metadata = {
      name: 'onedrive',
      description:
        'Microsoft OneDrive Dateiverwaltung: Dateien auflisten, suchen, hoch-/herunterladen, ' +
        'teilen, Ordner erstellen. Zugriff auf eigene Dateien und freigegebene Ordner. ' +
        'OneDrive, Datei, Ordner, Cloud, Speicher, Upload, Download, Teilen, SharePoint, ' +
        'Cloud-Drive, Ablage, Verzeichnis.',
      version: '1.0.0',
      riskLevel: 'write',
      category: 'files',
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'list', 'search', 'info', 'download', 'upload',
              'create_folder', 'delete', 'move', 'copy',
              'share', 'shared_with_me', 'recent',
              'ingest', 'list_accounts',
            ],
            description: 'Action to perform.',
          },
          ...accountProp,
          path: { type: 'string', description: 'File or folder path (e.g. "Documents/report.pdf"). Defaults to root "/".' },
          itemId: { type: 'string', description: 'OneDrive item ID (alternative to path).' },
          query: { type: 'string', description: 'Search query (for search action).' },
          limit: { type: 'number', description: 'Max results to return (default 20).' },
          content: { type: 'string', description: 'Text content for upload.' },
          fileStoreKey: { type: 'string', description: 'FileStore key for binary upload.' },
          destFolder: { type: 'string', description: 'Destination folder path (for move/copy).' },
          newName: { type: 'string', description: 'New file name (for move/copy).' },
          folderName: { type: 'string', description: 'Folder name (for create_folder).' },
          parentPath: { type: 'string', description: 'Parent folder path (for create_folder).' },
          shareType: { type: 'string', enum: ['view', 'edit'], description: 'Share link type (default: view).' },
          expirationDateTime: { type: 'string', description: 'Share link expiration (ISO 8601).' },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    // Resolve per-user onedrive configs if available
    const userConfigs = await this.resolveUserConfigs(context);
    this.activeConfigs = userConfigs ?? undefined;

    try {
      // Multi-user: non-admin users must have their own config, no fallback to global
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
        return { success: false, error: 'OneDrive ist nicht konfiguriert. Nutze "auth_microsoft" um Microsoft 365 zu verbinden.' };
      }

      const action = input.action as string;

      if (action === 'list_accounts') return this.handleListAccounts(cfgs);

      // Resolve config for the requested account
      const resolved = this.resolveConfig(input);
      if ('success' in resolved) return resolved;
      const { cfg, account } = resolved;

      // Check Files scope (cached)
      const hasScope = await this.checkFilesScope(cfg, account);
      if (!hasScope) {
        return {
          success: false,
          error: 'OneDrive-Zugriff nicht autorisiert. Führe "auth_microsoft" erneut aus um die Dateiberechtigung zu erteilen.',
        };
      }

      try {
        switch (action) {
          case 'list': return await this.handleList(input, cfg, account);
          case 'search': return await this.handleSearch(input, cfg, account);
          case 'info': return await this.handleInfo(input, cfg, account);
          case 'download': return await this.handleDownload(input, cfg, account);
          case 'upload': return await this.handleUpload(input, cfg, account, context);
          case 'create_folder': return await this.handleCreateFolder(input, cfg, account);
          case 'delete': return await this.handleDelete(input, cfg, account);
          case 'move': return await this.handleMove(input, cfg, account);
          case 'copy': return await this.handleCopy(input, cfg, account);
          case 'share': return await this.handleShare(input, cfg, account);
          case 'shared_with_me': return await this.handleSharedWithMe(input, cfg, account);
          case 'recent': return await this.handleRecent(input, cfg, account);
          case 'ingest': return await this.handleIngest(input, cfg, account, context);
          default:
            return { success: false, error: `Unbekannte Aktion: ${action}` };
        }
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        // 404, 403, 429 are not skill failures
        if (msg.includes('404')) return { success: false, error: 'Datei oder Ordner nicht gefunden.' };
        if (msg.includes('403') || msg.includes('Authorization_RequestDenied')) {
          return { success: false, error: 'Zugriff verweigert. Prüfe die Berechtigungen.' };
        }
        if (msg.includes('429')) {
          return { success: false, error: 'Rate Limit erreicht. Bitte kurz warten und erneut versuchen.' };
        }
        return { success: false, error: msg };
      }
    } finally {
      this.activeConfigs = undefined;
      this.mergedConfigs = undefined;
    }
  }

  // ── Config Resolution ───────────────────────────────────────────

  private async resolveUserConfigs(context: SkillContext): Promise<Map<string, MicrosoftTodoConfig> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'onedrive');
    if (services.length === 0) {
      // Fall back to todo configs (same MS Graph token)
      const todoServices = await context.userServiceResolver.getUserServices(context.alfredUserId, 'todo');
      if (todoServices.length === 0) return null;
      const cfgs = new Map<string, MicrosoftTodoConfig>();
      for (const svc of todoServices) {
        if (svc.config && (svc.config as any).clientId) {
          cfgs.set(svc.serviceName, svc.config as unknown as MicrosoftTodoConfig);
        }
      }
      return cfgs.size > 0 ? cfgs : null;
    }

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
        error: `Unbekannter OneDrive-Account "${account}". Verfügbar: ${accountNames.join(', ')}`,
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
      return { success: true, data: { accounts: [] }, display: 'Keine OneDrive-Accounts konfiguriert.\nNutze "auth_microsoft" um Microsoft 365 zu verbinden.' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfügbare OneDrive-Accounts:\n${names.map((n, i) => `${i === 0 ? '• ' + n + ' (Standard)' : '• ' + n}`).join('\n')}`,
    };
  }

  // ── Scope Check ─────────────────────────────────────────────────

  private async checkFilesScope(cfg: MicrosoftTodoConfig, account: string): Promise<boolean> {
    const cached = this.scopeCache.get(account);
    if (cached && Date.now() - cached.ts < OneDriveSkill.SCOPE_TTL) return cached.ok;

    try {
      await this.graphRequest(cfg, account, `${this.getUserPath(cfg)}/drive`);
      this.scopeCache.set(account, { ok: true, ts: Date.now() });
      return true;
    } catch (err: any) {
      if (String(err).includes('403') || String(err).includes('Authorization_RequestDenied')) {
        this.scopeCache.set(account, { ok: false, ts: Date.now() });
        return false;
      }
      throw err;
    }
  }

  // ── Graph API helpers ─────────────────────────────────────────────

  private getUserPath(cfg: MicrosoftTodoConfig): string {
    return (cfg as any).sharedUser ? `/users/${(cfg as any).sharedUser}` : '/me';
  }

  private async refreshAccessToken(cfg: MicrosoftTodoConfig, account: string): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
    const doRefresh = async (includeSecret: boolean) => {
      const params: Record<string, string> = {
        client_id: cfg.clientId,
        refresh_token: cfg.refreshToken,
        grant_type: 'refresh_token',
        scope: 'openid offline_access',
      };
      if (includeSecret && cfg.clientSecret) params.client_secret = cfg.clientSecret;
      return fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    };

    let res = await doRefresh(true);
    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('AADSTS700025') || errText.includes('Client is public')) {
        res = await doRefresh(false);
      } else {
        throw new Error(`Microsoft token refresh failed: ${res.status}`);
      }
    }

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

  /** Raw fetch returning the Response object (for binary downloads). */
  private async graphFetch(cfg: MicrosoftTodoConfig, account: string, path: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken(cfg, account);

    const doFetch = (t: string) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        redirect: 'follow',
        headers: {
          Authorization: `Bearer ${t}`,
          ...options.headers,
        },
      });

    let res = await doFetch(token);

    if (res.status === 401) {
      const newToken = await this.refreshAccessToken(cfg, account);
      res = await doFetch(newToken);
      if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    } else if (!res.ok && res.status !== 302) {
      throw new Error(`Graph API error: ${res.status}`);
    }

    return res;
  }

  // ── Path helpers ──────────────────────────────────────────────────

  private drivePath(userPath: string, filePath?: string): string {
    if (!filePath || filePath === '/') return `${userPath}/drive/root`;
    const clean = filePath.replace(/^\/+/, '').replace(/\/+$/, '');
    return `${userPath}/drive/root:/${clean}:`;
  }

  private driveChildrenPath(userPath: string, folderPath?: string): string {
    if (!folderPath || folderPath === '/') return `${userPath}/drive/root/children`;
    const clean = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
    return `${userPath}/drive/root:/${clean}:/children`;
  }

  private itemPath(userPath: string, input: Record<string, unknown>): string {
    if (input.itemId) return `${userPath}/drive/items/${input.itemId}`;
    if (input.path) return this.drivePath(userPath, input.path as string);
    return `${userPath}/drive/root`;
  }

  // ── Display helpers ───────────────────────────────────────────────

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  private formatItem(item: any): string {
    const icon = item.folder ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
    const size = item.size != null ? ` (${this.formatSize(item.size)})` : '';
    const date = item.lastModifiedDateTime ? ` — ${this.formatDate(item.lastModifiedDateTime)}` : '';
    return `${icon} ${item.name}${size}${date}`;
  }

  // ── Actions ───────────────────────────────────────────────────────

  private async handleList(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const userPath = this.getUserPath(cfg);
    const folderPath = input.path as string | undefined;
    const limit = (input.limit as number) || 20;

    const apiPath = `${this.driveChildrenPath(userPath, folderPath)}?$top=${limit}&$select=name,size,lastModifiedDateTime,folder,file,webUrl,id`;
    const data = await this.graphRequest(cfg, account, apiPath);
    const items = (data.value ?? []) as any[];

    const display = items.length > 0
      ? items.map(i => this.formatItem(i)).join('\n')
      : 'Ordner ist leer.';

    return {
      success: true,
      data: items.map(i => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder, lastModified: i.lastModifiedDateTime, webUrl: i.webUrl })),
      display: this.accountLabel(account, `${folderPath || '/'}\n${display}`),
    };
  }

  private async handleSearch(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) return { success: false, error: 'query ist erforderlich für die Suche.' };

    const userPath = this.getUserPath(cfg);
    const limit = (input.limit as number) || 20;

    const data = await this.graphRequest(cfg, account, `${userPath}/drive/root/search(q='${encodeURIComponent(query)}')?$top=${limit}`);
    const items = (data.value ?? []) as any[];

    const display = items.length > 0
      ? items.map((i: any) => this.formatItem(i)).join('\n')
      : `Keine Ergebnisse für "${query}".`;

    return {
      success: true,
      data: items.map((i: any) => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder, lastModified: i.lastModifiedDateTime, webUrl: i.webUrl })),
      display: this.accountLabel(account, `Suche: "${query}"\n${display}`),
    };
  }

  private async handleInfo(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const userPath = this.getUserPath(cfg);
    const path = this.itemPath(userPath, input);

    const item = await this.graphRequest(cfg, account, path);

    const lines = [
      `Name: ${item.name}`,
      item.size != null ? `Größe: ${this.formatSize(item.size)}` : null,
      item.createdDateTime ? `Erstellt: ${this.formatDate(item.createdDateTime)}` : null,
      item.lastModifiedDateTime ? `Geändert: ${this.formatDate(item.lastModifiedDateTime)}` : null,
      item.webUrl ? `URL: ${item.webUrl}` : null,
      item.folder ? `Typ: Ordner (${item.folder.childCount} Elemente)` : 'Typ: Datei',
      item.shared ? `Geteilt: Ja` : null,
    ].filter(Boolean);

    return {
      success: true,
      data: item,
      display: this.accountLabel(account, lines.join('\n')),
    };
  }

  private async handleDownload(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const userPath = this.getUserPath(cfg);

    // First get item info for size and name
    const infoPath = this.itemPath(userPath, input);
    const item = await this.graphRequest(cfg, account, infoPath);

    if (item.folder) return { success: false, error: 'Ordner können nicht heruntergeladen werden.' };

    const TEN_MB = 10 * 1024 * 1024;
    if (item.size > TEN_MB) {
      // For large files, return download URL
      const downloadUrl = item['@microsoft.graph.downloadUrl'] || item.webUrl;
      return {
        success: true,
        data: { name: item.name, size: item.size, downloadUrl },
        display: this.accountLabel(account, `Datei zu groß für direkten Download (${this.formatSize(item.size)}).\nDownload-URL: ${downloadUrl}`),
      };
    }

    // Download the file content
    const contentPath = input.itemId
      ? `${userPath}/drive/items/${input.itemId}/content`
      : `${this.drivePath(userPath, input.path as string)}/content`;

    const res = await this.graphFetch(cfg, account, contentPath);
    const buffer = Buffer.from(await res.arrayBuffer());

    const mimeType = item.file?.mimeType || 'application/octet-stream';

    return {
      success: true,
      data: { name: item.name, size: item.size, mimeType },
      display: this.accountLabel(account, `${item.name} heruntergeladen (${this.formatSize(item.size)})`),
      attachments: [{ fileName: item.name, data: buffer, mimeType }],
    };
  }

  private async handleUpload(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string, context: SkillContext): Promise<SkillResult> {
    const filePath = input.path as string;
    if (!filePath) return { success: false, error: 'path ist erforderlich für Upload (z.B. "Documents/datei.txt").' };

    const userPath = this.getUserPath(cfg);
    let body: Buffer | string;

    if (input.fileStoreKey) {
      if (!context.fileStore) return { success: false, error: 'FileStore nicht verfügbar.' };
      body = await context.fileStore.read(input.fileStoreKey as string, context.alfredUserId);
    } else if (input.content) {
      body = input.content as string;
    } else {
      return { success: false, error: 'content oder fileStoreKey ist erforderlich für Upload.' };
    }

    const clean = filePath.replace(/^\/+/, '').replace(/\/+$/, '');
    const uploadPath = `${userPath}/drive/root:/${clean}:/content`;

    const token = await this.getAccessToken(cfg, account);
    const res = await fetch(`https://graph.microsoft.com/v1.0${uploadPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
    });

    if (res.status === 401) {
      const newToken = await this.refreshAccessToken(cfg, account);
      const retry = await fetch(`https://graph.microsoft.com/v1.0${uploadPath}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${newToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body,
      });
      if (!retry.ok) throw new Error(`Graph API error: ${retry.status}`);
      const item = await retry.json() as any;
      return {
        success: true,
        data: { id: item.id, name: item.name, size: item.size, webUrl: item.webUrl },
        display: this.accountLabel(account, `${item.name} hochgeladen (${this.formatSize(item.size)})`),
      };
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);

    const item = await res.json() as any;
    return {
      success: true,
      data: { id: item.id, name: item.name, size: item.size, webUrl: item.webUrl },
      display: this.accountLabel(account, `${item.name} hochgeladen (${this.formatSize(item.size)})`),
    };
  }

  private async handleCreateFolder(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const folderName = input.folderName as string;
    if (!folderName) return { success: false, error: 'folderName ist erforderlich.' };

    const userPath = this.getUserPath(cfg);
    const parentPath = input.parentPath as string | undefined;
    const apiPath = this.driveChildrenPath(userPath, parentPath);

    const item = await this.graphRequest(cfg, account, apiPath, {
      method: 'POST',
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });

    return {
      success: true,
      data: { id: item.id, name: item.name, webUrl: item.webUrl },
      display: this.accountLabel(account, `Ordner "${item.name}" erstellt.`),
    };
  }

  private async handleDelete(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    if (!input.itemId && !input.path) return { success: false, error: 'itemId oder path ist erforderlich.' };

    const userPath = this.getUserPath(cfg);
    const path = this.itemPath(userPath, input);

    await this.graphRequest(cfg, account, path, { method: 'DELETE' });

    return { success: true, display: this.accountLabel(account, 'Datei/Ordner gelöscht.') };
  }

  private async handleMove(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    if (!input.itemId && !input.path) return { success: false, error: 'itemId oder path ist erforderlich.' };
    if (!input.destFolder) return { success: false, error: 'destFolder ist erforderlich.' };

    const userPath = this.getUserPath(cfg);

    // If we have a path but no itemId, resolve itemId first
    let itemId = input.itemId as string;
    if (!itemId) {
      const infoPath = this.drivePath(userPath, input.path as string);
      const item = await this.graphRequest(cfg, account, infoPath);
      itemId = item.id;
    }

    const destClean = (input.destFolder as string).replace(/^\/+/, '').replace(/\/+$/, '');
    const patchBody: Record<string, unknown> = {
      parentReference: { path: `/drive/root:/${destClean}` },
    };
    if (input.newName) patchBody.name = input.newName;

    const updated = await this.graphRequest(cfg, account, `${userPath}/drive/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    });

    return {
      success: true,
      data: { id: updated.id, name: updated.name, webUrl: updated.webUrl },
      display: this.accountLabel(account, `"${updated.name}" verschoben nach ${input.destFolder}.`),
    };
  }

  private async handleCopy(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    if (!input.itemId && !input.path) return { success: false, error: 'itemId oder path ist erforderlich.' };
    if (!input.destFolder) return { success: false, error: 'destFolder ist erforderlich.' };

    const userPath = this.getUserPath(cfg);

    // Resolve itemId if needed
    let itemId = input.itemId as string;
    if (!itemId) {
      const infoPath = this.drivePath(userPath, input.path as string);
      const item = await this.graphRequest(cfg, account, infoPath);
      itemId = item.id;
    }

    const destClean = (input.destFolder as string).replace(/^\/+/, '').replace(/\/+$/, '');
    const copyBody: Record<string, unknown> = {
      parentReference: { path: `/drive/root:/${destClean}` },
    };
    if (input.newName) copyBody.name = input.newName;

    // Copy returns 202 Accepted with a monitor URL
    const token = await this.getAccessToken(cfg, account);
    const res = await fetch(`https://graph.microsoft.com/v1.0${userPath}/drive/items/${itemId}/copy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(copyBody),
    });

    if (res.status === 401) {
      const newToken = await this.refreshAccessToken(cfg, account);
      const retry = await fetch(`https://graph.microsoft.com/v1.0${userPath}/drive/items/${itemId}/copy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${newToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(copyBody),
      });
      if (!retry.ok && retry.status !== 202) throw new Error(`Graph API error: ${retry.status}`);
    } else if (!res.ok && res.status !== 202) {
      throw new Error(`Graph API error: ${res.status}`);
    }

    return {
      success: true,
      display: this.accountLabel(account, `Kopie nach ${input.destFolder} gestartet.`),
    };
  }

  private async handleShare(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    if (!input.itemId && !input.path) return { success: false, error: 'itemId oder path ist erforderlich.' };

    const userPath = this.getUserPath(cfg);

    // Resolve itemId if needed
    let itemId = input.itemId as string;
    if (!itemId) {
      const infoPath = this.drivePath(userPath, input.path as string);
      const item = await this.graphRequest(cfg, account, infoPath);
      itemId = item.id;
    }

    const shareType = (input.shareType as string) || 'view';
    const body: Record<string, unknown> = {
      type: shareType,
      scope: 'anonymous',
    };
    if (input.expirationDateTime) body.expirationDateTime = input.expirationDateTime;

    const result = await this.graphRequest(cfg, account, `${userPath}/drive/items/${itemId}/createLink`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const link = result?.link?.webUrl || result?.link?.webHtml || 'Link erstellt';

    return {
      success: true,
      data: { link: result.link, shareId: result.id },
      display: this.accountLabel(account, `Freigabe-Link (${shareType}):\n${link}`),
    };
  }

  private async handleSharedWithMe(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const userPath = this.getUserPath(cfg);
    const limit = (input.limit as number) || 20;

    const data = await this.graphRequest(cfg, account, `${userPath}/drive/sharedWithMe?$top=${limit}`);
    const items = (data.value ?? []) as any[];

    const display = items.length > 0
      ? items.map((i: any) => this.formatItem(i)).join('\n')
      : 'Keine freigegebenen Dateien.';

    return {
      success: true,
      data: items.map((i: any) => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder, webUrl: i.webUrl })),
      display: this.accountLabel(account, `Mit mir geteilt:\n${display}`),
    };
  }

  private async handleRecent(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string): Promise<SkillResult> {
    const userPath = this.getUserPath(cfg);
    const limit = (input.limit as number) || 20;

    const data = await this.graphRequest(cfg, account, `${userPath}/drive/recent?$top=${limit}`);
    const items = (data.value ?? []) as any[];

    const display = items.length > 0
      ? items.map((i: any) => this.formatItem(i)).join('\n')
      : 'Keine kürzlich verwendeten Dateien.';

    return {
      success: true,
      data: items.map((i: any) => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder, lastModified: i.lastModifiedDateTime, webUrl: i.webUrl })),
      display: this.accountLabel(account, `Zuletzt verwendet:\n${display}`),
    };
  }

  private async handleIngest(input: Record<string, unknown>, cfg: MicrosoftTodoConfig, account: string, context: SkillContext): Promise<SkillResult> {
    if (!input.itemId && !input.path) return { success: false, error: 'itemId oder path ist erforderlich.' };

    const userPath = this.getUserPath(cfg);

    // Get file info
    const infoPath = this.itemPath(userPath, input);
    const item = await this.graphRequest(cfg, account, infoPath);

    if (item.folder) return { success: false, error: 'Ordner können nicht indiziert werden. Bitte einzelne Dateien angeben.' };

    // Download content
    const contentPath = input.itemId
      ? `${userPath}/drive/items/${input.itemId}/content`
      : `${this.drivePath(userPath, input.path as string)}/content`;

    const res = await this.graphFetch(cfg, account, contentPath);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Try to use document processor via skill registry
    if (!context.fileStore) {
      return { success: false, error: 'FileStore nicht verfügbar — Ingest benötigt FileStore.' };
    }

    // Save to FileStore as temp
    const userId = context.alfredUserId || 'system';
    const saved = await context.fileStore.save(userId, item.name, buffer);

    return {
      success: true,
      data: { name: item.name, size: item.size, fileStoreKey: saved.key },
      display: this.accountLabel(
        account,
        `"${item.name}" (${this.formatSize(item.size)}) heruntergeladen und im FileStore gespeichert (Key: ${saved.key}).\nNutze document.ingest mit fileStoreKey="${saved.key}" um das Dokument zu indizieren.`,
      ),
    };
  }
}
