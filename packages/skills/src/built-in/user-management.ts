import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { AlfredUserRepository, UserRole } from '@alfred/storage';

const VALID_ROLES: UserRole[] = ['admin', 'user', 'family', 'guest', 'service'];

/** Skills accessible per role. Admin gets all (*). */
const ROLE_SKILL_ACCESS: Record<UserRole, string[] | '*'> = {
  admin: '*',
  user: [
    'calculator', 'weather', 'web_search', 'reminder', 'note', 'todo',
    'memory', 'email', 'calendar', 'contacts', 'bmw', 'youtube',
    'feed_reader', 'watch', 'workflow', 'database', 'routing', 'transit',
    'energy_price', 'marketplace', 'briefing', 'delegate', 'user_management', 'help',
    'file', 'code_sandbox', 'document', 'scheduled_task', 'microsoft_todo', 'sharing', 'background_task',
  ],
  family: [
    'calculator', 'weather', 'web_search', 'reminder', 'note', 'todo',
    'memory', 'email', 'calendar', 'contacts', 'routing', 'transit',
    'energy_price', 'briefing', 'youtube', 'feed_reader', 'user_management', 'help',
    'file', 'document', 'scheduled_task',
  ],
  guest: [
    'calculator', 'weather', 'web_search', 'routing', 'transit',
    'energy_price', 'youtube', 'user_management', 'help',
  ],
  service: [
    'calculator', 'weather', 'web_search', 'user_management', 'help',
  ],
};

export { ROLE_SKILL_ACCESS };

export class UserManagementSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'user_management',
    category: 'identity',
    description: `Manage Alfred users and personal service configs. Admin-only: create_user, list_users, set_role, deactivate, activate, delete. Any user: whoami, connect, setup_service, my_services, remove_service.
Actions:
- create_user: Create a new user (admin only). Params: username, role, displayName
- list_users: List all users (admin only)
- set_role: Change user role (admin only). Params: username, role
- deactivate/activate/delete: User management (admin only). Params: username
- invite: Regenerate invite code (admin only). Params: username
- whoami: Show current user info
- connect: Connect platform with invite code. Params: code
- setup_service: Configure a personal service. Params: service_type, service_name, config. For email: config only needs {email, password} — known providers (gmx, gmail, yahoo, outlook, icloud, web.de, posteo, mailbox.org, aon, a1, hotmail) are auto-configured. Example: service_type:"email", service_name:"gmx", config:{email:"user@gmx.at", password:"pass"}
- my_services: List your configured services
- remove_service: Remove a personal service. Params: service_type, service_name
- share_service: Share a service with another user (admin only). Params: username, service_type, service_name, shared_resource (email of shared mailbox/calendar). For Microsoft 365: shared_resource is REQUIRED — it specifies the shared mailbox/calendar/todo (e.g. "office@firma.at"), your own account is NEVER shared. Example: share_service username:"alex" service_type:"email" service_name:"outlook" shared_resource:"office@firma.at"
- auth_microsoft: Connect your Microsoft 365 account (email, calendar, contacts, todo) via Device Code Flow. No params needed — Alfred provides a code, you sign in at microsoft.com/devicelogin. Uses the default tenant. Optional: tenant_id for a different tenant.
- add_shared_resource: Add a shared/delegated Microsoft 365 resource (calendar, mailbox, contacts, todo) to your account. Uses your existing credentials + adds the shared resource as an additional account. Params: service_type (email/calendar/contacts/todo), shared_resource (email of shared resource, e.g. "fam@dohnal.co"), service_name (optional display name).`,
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 900_000, // 15 min — Device Code Flow needs time for user to authenticate
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_user', 'list_users', 'set_role', 'deactivate', 'activate', 'delete', 'invite', 'whoami', 'connect', 'setup_service', 'my_services', 'remove_service', 'share_service', 'auth_microsoft', 'add_shared_resource'],
        },
        username: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'user', 'family', 'guest', 'service'] },
        displayName: { type: 'string' },
        code: { type: 'string', description: 'Invite code (for connect action)' },
        service_type: { type: 'string', description: 'Service type: email, calendar, bmw, contacts, todo' },
        service_name: { type: 'string', description: 'Service name (e.g. "outlook", "gmail", "google-calendar")' },
        config: { type: 'object', description: 'Service config JSON (credentials, endpoints)' },
        target_username: { type: 'string', description: 'Target username for sharing' },
        shared_resource: { type: 'string', description: 'Email address of shared resource (for share_service with Microsoft 365). E.g. "office@firma.at" for a shared mailbox. REQUIRED for M365 to prevent sharing your own account.' },
        tenant_id: { type: 'string', description: 'Microsoft tenant ID (for auth_microsoft). Optional — uses default tenant if omitted. Only needed for accounts on a different tenant.' },
      },
      required: ['action'],
    },
  };

  /** Microsoft App credentials for Device Code Flow (from admin config). */
  private msAppCredentials?: { clientId: string; clientSecret: string; tenantId?: string };
  /** Global MS configs per service type for add_shared_resource. */
  private msGlobalConfigs?: Record<string, Record<string, unknown>>;

  constructor(
    private readonly userRepo: AlfredUserRepository,
    msAppCredentials?: { clientId: string; clientSecret: string; tenantId?: string },
    msGlobalConfigs?: Record<string, Record<string, unknown>>,
  ) {
    super();
    this.msAppCredentials = msAppCredentials;
    this.msGlobalConfigs = msGlobalConfigs;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;
    const callerUser = await this.userRepo.getUserByPlatform(context.platform, context.userId);

    switch (action) {
      case 'whoami':
        return this.whoami(context, callerUser);
      case 'connect':
        return this.connectPlatform(input, context);
      case 'setup_service':
        return this.setupService(input, context, callerUser);
      case 'my_services':
        return this.listServices(context, callerUser);
      case 'remove_service':
        return this.removeService(input, context, callerUser);
      case 'auth_microsoft':
        return this.authMicrosoft(input, context, callerUser);
      case 'add_shared_resource':
        return this.addSharedResource(input, context, callerUser);
      case 'create_user':
      case 'list_users':
      case 'set_role':
      case 'deactivate':
      case 'activate':
      case 'delete':
      case 'invite':
      case 'share_service':
        // Admin-only actions
        if (!callerUser || callerUser.role !== 'admin') {
          return { success: false, error: 'Nur Admins können User verwalten.' };
        }
        return this.adminAction(action, input, callerUser);
      default:
        return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private async whoami(context: SkillContext, user: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>): Promise<SkillResult> {
    if (!user) {
      return {
        success: true,
        data: { registered: false, platform: context.platform, platformUserId: context.userId },
        display: `Du bist noch nicht als Alfred-User registriert.\nPlattform: ${context.platform}\nUser-ID: ${context.userId}\n\nSage "connect" mit einem Invite-Code um dich zu verbinden.`,
      };
    }

    const links = await this.userRepo.getPlatformLinks(user.id);
    const services = await this.userRepo.getServices(user.id);

    return {
      success: true,
      data: { user, links, services },
      display: `**${user.displayName ?? user.username}** (${user.role})\n` +
        `Username: ${user.username}\n` +
        `Aktiv: ${user.active ? '✅' : '❌'}\n` +
        `Plattformen: ${links.map(l => l.platform).join(', ') || '—'}\n` +
        `Dienste: ${services.map(s => `${s.serviceType}/${s.serviceName}`).join(', ') || '—'}\n` +
        `Registriert: ${user.createdAt.slice(0, 10)}`,
    };
  }

  private async connectPlatform(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const code = input.code as string;
    if (!code) return { success: false, error: 'Bitte Invite-Code angeben.' };

    // Atomic: verify code + link platform + clear code (prevents race condition)
    const existing = await this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (existing) {
      return { success: false, error: `Diese ${context.platform}-ID ist bereits mit User "${existing.username}" verbunden.` };
    }

    const user = await this.userRepo.consumeInviteCode(code, context.platform, context.userId);
    if (!user) return { success: false, error: 'Ungültiger oder abgelaufener Invite-Code.' };

    return {
      success: true,
      data: { userId: user.id, username: user.username, platform: context.platform },
      display: `✅ Willkommen ${user.displayName ?? user.username}!\n` +
        `Dein ${context.platform}-Account ist jetzt mit Alfred verbunden.\n` +
        `Rolle: ${user.role}\n\n` +
        `Du kannst jetzt persönliche Dienste einrichten:\n` +
        `• "Verbinde mein Email" — Gmail, Outlook, etc.\n` +
        `• "Verbinde meinen Kalender" — Google, Microsoft\n` +
        `• "Zeig mein Profil" — Deine Infos anzeigen`,
    };
  }

  private async adminAction(action: string, input: Record<string, unknown>, admin: { id: string }): Promise<SkillResult> {
    switch (action) {
      case 'create_user': {
        const username = input.username as string;
        const role = (input.role as UserRole) ?? 'user';
        const displayName = input.displayName as string | undefined;
        if (!username) return { success: false, error: 'Username fehlt.' };
        if (!VALID_ROLES.includes(role)) return { success: false, error: `Ungültige Rolle: ${role}. Erlaubt: ${VALID_ROLES.join(', ')}` };

        const existing = await this.userRepo.getByUsername(username);
        if (existing) return { success: false, error: `User "${username}" existiert bereits.` };

        const user = await this.userRepo.create({ username, role, displayName, createdBy: admin.id });

        return {
          success: true,
          data: { userId: user.id, username, role, inviteCode: user.inviteCode },
          display: `✅ User "${username}" erstellt (Rolle: ${role}).\n\n` +
            `Invite-Code: **${user.inviteCode}** (24h gültig)\n\n` +
            `Der User kann sich verbinden:\n` +
            `• Telegram: Alfred-Bot anschreiben, Code eingeben\n` +
            `• Matrix: @alfred-ai anschreiben, Code eingeben\n` +
            `• Web Chat: /alfred/ → Code eingeben`,
        };
      }

      case 'list_users': {
        const users = await this.userRepo.getAll();
        if (users.length === 0) return { success: true, data: [], display: 'Keine User angelegt.' };

        const lines = await Promise.all(users.map(async u => {
          const links = await this.userRepo.getPlatformLinks(u.id);
          const platforms = links.map(l => l.platform).join(', ') || '—';
          return `• **${u.username}** (${u.role}) — ${u.active ? '✅' : '❌'} — Plattformen: ${platforms}${u.inviteCode ? ` — Code: ${u.inviteCode}` : ''}`;
        }));

        return {
          success: true,
          data: users,
          display: `**Alfred User (${users.length}):**\n${lines.join('\n')}`,
        };
      }

      case 'set_role': {
        const username = input.username as string;
        const role = input.role as UserRole;
        if (!username || !role) return { success: false, error: 'Username und Rolle erforderlich.' };
        if (!VALID_ROLES.includes(role)) return { success: false, error: `Ungültige Rolle: ${role}.` };

        const user = await this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };

        await this.userRepo.updateRole(user.id, role);
        return { success: true, data: { username, role }, display: `✅ Rolle von "${username}" auf "${role}" geändert.` };
      }

      case 'deactivate': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = await this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        await this.userRepo.deactivate(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" deaktiviert.` };
      }

      case 'activate': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = await this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        await this.userRepo.activate(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" aktiviert.` };
      }

      case 'delete': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = await this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        await this.userRepo.delete(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" gelöscht.` };
      }

      case 'invite': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = await this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        const code = await this.userRepo.regenerateInviteCode(user.id);
        return { success: true, data: { username, inviteCode: code }, display: `✅ Neuer Invite-Code für "${username}": **${code}** (24h gültig)` };
      }

      case 'share_service':
        return this.shareService(input, admin);

      default:
        return { success: false, error: `Unbekannte Admin-Aktion: ${action}` };
    }
  }

  // ── Service Management ──────────────────────────────────────

  // Well-known email provider templates: only email + password needed
  private static readonly EMAIL_TEMPLATES: Record<string, { imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number; secure: boolean } }> = {
    'gmx': { imap: { host: 'imap.gmx.net', port: 993, secure: true }, smtp: { host: 'mail.gmx.net', port: 587, secure: false } },
    'gmx.at': { imap: { host: 'imap.gmx.at', port: 993, secure: true }, smtp: { host: 'mail.gmx.at', port: 587, secure: false } },
    'gmail': { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false } },
    'yahoo': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, secure: false } },
    'icloud': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
    'aon': { imap: { host: 'imap.aon.at', port: 993, secure: true }, smtp: { host: 'smtp.aon.at', port: 587, secure: false } },
    'a1': { imap: { host: 'imap.a1.net', port: 993, secure: true }, smtp: { host: 'smtp.a1.net', port: 587, secure: false } },
    'hotmail': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
    'outlook': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
    'web.de': { imap: { host: 'imap.web.de', port: 993, secure: true }, smtp: { host: 'smtp.web.de', port: 587, secure: false } },
    'posteo': { imap: { host: 'posteo.de', port: 993, secure: true }, smtp: { host: 'posteo.de', port: 587, secure: true } },
    'mailbox.org': { imap: { host: 'imap.mailbox.org', port: 993, secure: true }, smtp: { host: 'smtp.mailbox.org', port: 587, secure: true } },
  };

  private resolveEmailConfig(serviceName: string, config: Record<string, unknown>): Record<string, unknown> {
    const email = config.email as string | undefined;
    const password = config.password as string | undefined;

    // If full config already provided (imap/smtp/auth), use as-is
    if (config.imap || config.smtp || config.auth || config.provider === 'microsoft') {
      return config;
    }

    if (!email || !password) {
      throw new Error('email und password sind erforderlich.');
    }

    // Try to match template by service name or email domain
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    const templateKey = serviceName.toLowerCase();
    const template = UserManagementSkill.EMAIL_TEMPLATES[templateKey]
      ?? UserManagementSkill.EMAIL_TEMPLATES[domain.replace(/\.(com|net|at|de|org)$/, '')]
      ?? UserManagementSkill.EMAIL_TEMPLATES[domain];

    if (!template) {
      throw new Error(
        `Unbekannter Email-Provider "${serviceName}". Bekannte Provider: ${Object.keys(UserManagementSkill.EMAIL_TEMPLATES).join(', ')}. ` +
        `Alternativ: vollständige config mit imap/smtp/auth angeben.`,
      );
    }

    return {
      type: 'standard',
      imap: template.imap,
      smtp: template.smtp,
      auth: { user: email, pass: password },
    };
  }

  private async setupService(
    input: Record<string, unknown>,
    context: SkillContext,
    callerUser: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>,
  ): Promise<SkillResult> {
    if (!callerUser) return { success: false, error: 'Du musst registriert sein. Nutze "connect" mit einem Invite-Code.' };
    if (!context.userServiceResolver) return { success: false, error: 'Service-Konfiguration nicht verfügbar.' };

    const serviceType = input.service_type as string;
    const serviceName = input.service_name as string;
    const config = input.config as Record<string, unknown>;

    if (!serviceType) return { success: false, error: 'service_type ist erforderlich (email, calendar, bmw, contacts, todo).' };
    if (!serviceName) return { success: false, error: 'service_name ist erforderlich (z.B. "gmx", "gmail", "google-calendar").' };
    if (!config || typeof config !== 'object') return { success: false, error: 'config ist erforderlich. Für Email: {email, password}. Bekannte Provider werden automatisch konfiguriert.' };

    const validTypes = ['email', 'calendar', 'bmw', 'goe_charger', 'contacts', 'todo', 'recipe', 'travel', 'spotify', 'onedrive', 'mqtt'];
    if (!validTypes.includes(serviceType)) {
      return { success: false, error: `Ungültiger service_type. Erlaubt: ${validTypes.join(', ')}` };
    }

    // Auto-resolve email provider templates
    let resolvedConfig = config;
    if (serviceType === 'email') {
      try {
        resolvedConfig = this.resolveEmailConfig(serviceName, config);
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    await context.userServiceResolver.saveServiceConfig(callerUser.id, serviceType, serviceName, resolvedConfig);

    // Security hint when plain-text password is stored (IMAP email)
    const hasPassword = config && typeof config === 'object' && ('password' in config);
    const securityHint = hasPassword
      ? '\n\n⚠️ **Sicherheitshinweis:** Dein Passwort wird verschlüsselt gespeichert. Für höhere Sicherheit empfehlen wir App-spezifische Passwörter oder Microsoft 365 (auth_microsoft).'
      : '';

    return {
      success: true,
      data: { serviceType, serviceName },
      display: `✅ Service "${serviceName}" (${serviceType}) konfiguriert.\n\nDeine persönliche ${serviceType}-Konfiguration wird ab sofort verwendet.${securityHint}`,
    };
  }

  private async listServices(
    context: SkillContext,
    callerUser: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>,
  ): Promise<SkillResult> {
    if (!callerUser) return { success: false, error: 'Du musst registriert sein.' };
    if (!context.userServiceResolver) return { success: false, error: 'Service-Konfiguration nicht verfügbar.' };

    const services = await context.userServiceResolver.getUserServices(callerUser.id);
    if (services.length === 0) {
      return { success: true, data: [], display: 'Keine persönlichen Services konfiguriert.\n\nNutze "setup_service" um Email, Kalender etc. einzurichten.' };
    }

    const lines = services.map(s => `• ${s.serviceType}/${s.serviceName}`);
    return {
      success: true,
      data: services.map(s => ({ type: s.serviceType, name: s.serviceName })),
      display: `Deine Services:\n${lines.join('\n')}`,
    };
  }

  private async removeService(
    input: Record<string, unknown>,
    context: SkillContext,
    callerUser: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>,
  ): Promise<SkillResult> {
    if (!callerUser) return { success: false, error: 'Du musst registriert sein.' };
    if (!context.userServiceResolver) return { success: false, error: 'Service-Konfiguration nicht verfügbar.' };

    const serviceType = input.service_type as string;
    const serviceName = input.service_name as string;
    if (!serviceType || !serviceName) return { success: false, error: 'service_type und service_name sind erforderlich.' };

    const removed = await context.userServiceResolver.removeServiceConfig(callerUser.id, serviceType, serviceName);
    if (!removed) return { success: false, error: `Service "${serviceName}" (${serviceType}) nicht gefunden.` };

    return { success: true, display: `✅ Service "${serviceName}" (${serviceType}) entfernt.` };
  }

  // ── Microsoft Device Code Flow ─────────────────────────────

  private async authMicrosoft(
    input: Record<string, unknown>,
    context: SkillContext,
    callerUser: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>,
  ): Promise<SkillResult> {
    if (!callerUser) return { success: false, error: 'Du musst registriert sein. Nutze "connect" mit einem Invite-Code.' };
    if (!context.userServiceResolver) return { success: false, error: 'Service-Konfiguration nicht verfügbar.' };

    if (!this.msAppCredentials?.clientId || !this.msAppCredentials?.clientSecret) {
      return { success: false, error: 'Microsoft 365 ist nicht konfiguriert. Der Admin muss zuerst eine Azure App Registration einrichten (ALFRED_MICROSOFT_EMAIL_CLIENT_ID etc. in .env).' };
    }

    const { clientId, clientSecret } = this.msAppCredentials;
    // Use admin's tenantId by default, allow user override for different tenant
    const tenantId = (input.tenant_id as string) || this.msAppCredentials.tenantId || 'common';
    const scopes = 'offline_access Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared Calendars.ReadWrite Calendars.ReadWrite.Shared Contacts.ReadWrite Contacts.ReadWrite.Shared Tasks.ReadWrite User.Read Files.ReadWrite.All Sites.Read.All';

    // Step 1: Device Code Request
    const deviceCodeRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: scopes }).toString(),
    });

    if (!deviceCodeRes.ok) {
      const err = await deviceCodeRes.text().catch(() => '');
      return { success: false, error: `Microsoft Device Code Request fehlgeschlagen: ${deviceCodeRes.status} — ${err.slice(0, 300)}` };
    }

    const deviceData = await deviceCodeRes.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
      message: string;
    };

    // Send user the code IMMEDIATELY via onProgress before polling starts
    const userMessage = `🔐 **Microsoft 365 verbinden**\n\n` +
      `1. Öffne: ${deviceData.verification_uri}\n` +
      `2. Gib diesen Code ein: **${deviceData.user_code}**\n` +
      `3. Melde dich mit deinem Microsoft-Konto an\n\n` +
      `⏳ Warte auf Bestätigung (max ${Math.round(deviceData.expires_in / 60)} Minuten)...`;

    // Send code to user IMMEDIATELY via onProgress (before polling blocks)
    if (context.onProgress) {
      context.onProgress(userMessage);
    }

    // Step 2: Poll for token (sync, like BMW skill)
    const pollInterval = (deviceData.interval || 5) * 1000;
    const deadline = Date.now() + deviceData.expires_in * 1000;
    let refreshToken: string | undefined;
    let pollError: string | undefined;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: clientId,
          client_secret: clientSecret,
          device_code: deviceData.device_code,
        }).toString(),
      });

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string };
        refreshToken = tokenData.refresh_token;
        break;
      }

      const errBody = await tokenRes.json().catch(() => ({ error: 'unknown' })) as { error: string; error_description?: string; error_codes?: number[] };

      if (errBody.error === 'authorization_pending') {
        continue; // User hasn't authenticated yet
      } else if (errBody.error === 'slow_down') {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Extra delay
        continue;
      } else if (errBody.error === 'expired_token') {
        pollError = 'Code abgelaufen. Bitte erneut versuchen.';
        break;
      } else if (errBody.error === 'authorization_declined') {
        pollError = 'Autorisierung abgelehnt.';
        break;
      } else {
        pollError = `Token-Fehler: ${errBody.error}${errBody.error_description ? ` — ${errBody.error_description.slice(0, 300)}` : ''}`;
        break;
      }
    }

    if (!refreshToken) {
      return {
        success: false,
        error: pollError ?? 'Timeout — keine Bestätigung innerhalb der Frist.',
        display: userMessage + '\n\n❌ ' + (pollError ?? 'Timeout'),
      };
    }

    // Step 3: Save service configs for user
    const baseConfig = { clientId, clientSecret, tenantId, refreshToken };

    try {
      await context.userServiceResolver.saveServiceConfig(
        callerUser.id, 'email', 'outlook',
        { provider: 'microsoft', microsoft: { ...baseConfig } },
      );
      await context.userServiceResolver.saveServiceConfig(
        callerUser.id, 'calendar', 'microsoft',
        { provider: 'microsoft', microsoft: { ...baseConfig } },
      );
      await context.userServiceResolver.saveServiceConfig(
        callerUser.id, 'contacts', 'microsoft',
        { provider: 'microsoft', microsoft: { ...baseConfig } },
      );
      // Todo uses flat config structure
      await context.userServiceResolver.saveServiceConfig(
        callerUser.id, 'todo', 'microsoft-todo',
        { ...baseConfig },
      );
    } catch (err) {
      return { success: false, error: `Token erhalten, aber Speichern fehlgeschlagen: ${(err as Error).message}` };
    }

    return {
      success: true,
      display: userMessage + '\n\n✅ **Microsoft 365 verbunden!**\n\n' +
        'Folgende Dienste sind jetzt konfiguriert:\n' +
        '• Email (Outlook)\n' +
        '• Kalender\n' +
        '• Kontakte\n' +
        '• Microsoft Todo\n\n' +
        'Du kannst jetzt z.B. "Zeig meine Emails" oder "Was steht im Kalender?" fragen.',
    };
  }

  // ── Add Shared Resource ────────────────────────────────────

  private async addSharedResource(
    input: Record<string, unknown>,
    context: SkillContext,
    callerUser: Awaited<ReturnType<AlfredUserRepository['getUserByPlatform']>>,
  ): Promise<SkillResult> {
    if (!callerUser) return { success: false, error: 'Du musst registriert sein. Nutze "connect" mit einem Invite-Code.' };
    if (!context.userServiceResolver) return { success: false, error: 'Service-Konfiguration nicht verfügbar.' };

    const serviceType = input.service_type as string;
    const sharedResource = input.shared_resource as string;
    const serviceName = (input.service_name as string) || sharedResource?.split('@')[0] || 'shared';

    if (!serviceType) return { success: false, error: 'service_type ist erforderlich (email, calendar, contacts, todo).' };
    if (!sharedResource) return { success: false, error: 'shared_resource ist erforderlich (Email-Adresse der freigegebenen Ressource, z.B. "fam@dohnal.co").' };

    const validTypes = ['email', 'calendar', 'contacts', 'todo', 'recipe', 'travel', 'onedrive'];
    if (!validTypes.includes(serviceType)) {
      return { success: false, error: `Ungültiger service_type. Erlaubt: ${validTypes.join(', ')}` };
    }

    // Find base config: first check per-user services, then global config
    let baseConfig: Record<string, unknown> | undefined;

    // 1. Try per-user service config
    const existingServices = await context.userServiceResolver.getUserServices(callerUser.id, serviceType);
    if (existingServices.length > 0) {
      // Use the first existing service as base (copy credentials, change shared resource)
      baseConfig = { ...(existingServices[0].config as Record<string, unknown>) };
    }

    // 2. Fallback to global MS config (admin only or if no per-user config)
    if (!baseConfig && this.msGlobalConfigs?.[serviceType]) {
      baseConfig = JSON.parse(JSON.stringify(this.msGlobalConfigs[serviceType]));
    }

    if (!baseConfig) {
      return { success: false, error: `Kein ${serviceType}-Dienst konfiguriert. Richte zuerst deinen eigenen ${serviceType}-Account ein (auth_microsoft oder setup_service).` };
    }

    // Add shared resource to config
    const sharedConfig = { ...baseConfig };
    if (sharedConfig.microsoft && typeof sharedConfig.microsoft === 'object') {
      const ms = { ...(sharedConfig.microsoft as Record<string, unknown>) };
      if (serviceType === 'email') ms.sharedMailbox = sharedResource;
      else if (serviceType === 'calendar') ms.sharedCalendar = sharedResource;
      else if (serviceType === 'contacts') ms.sharedUser = sharedResource;
      else if (serviceType === 'todo') ms.sharedUser = sharedResource;
      sharedConfig.microsoft = ms;
    } else {
      // Flat config (todo)
      if (serviceType === 'todo') (sharedConfig as any).sharedUser = sharedResource;
      else if (serviceType === 'email') (sharedConfig as any).sharedMailbox = sharedResource;
      else if (serviceType === 'calendar') (sharedConfig as any).sharedCalendar = sharedResource;
      else (sharedConfig as any).sharedUser = sharedResource;
    }

    // Save as additional service (does NOT replace existing ones)
    await context.userServiceResolver.saveServiceConfig(callerUser.id, serviceType, serviceName, sharedConfig);

    return {
      success: true,
      display: `✅ Freigegebene Ressource "${sharedResource}" als ${serviceType}/${serviceName} hinzugefügt.\n\n` +
        `Du hast jetzt Zugriff auf:\n` +
        `• Deinen eigenen ${serviceType}-Account (Standard)\n` +
        `• ${sharedResource} (Account: "${serviceName}")\n\n` +
        `Nutze \`account: "${serviceName}"\` um explizit auf die freigegebene Ressource zuzugreifen.`,
    };
  }

  // ── Service Sharing (admin only) ───────────────────────────

  private async shareService(
    input: Record<string, unknown>,
    admin: { id: string },
  ): Promise<SkillResult> {
    const targetUsername = (input.target_username ?? input.username) as string;
    const serviceType = input.service_type as string;
    const serviceName = input.service_name as string;
    const sharedResource = input.shared_resource as string | undefined;

    if (!targetUsername || !serviceType || !serviceName) {
      return { success: false, error: 'username, service_type und service_name sind erforderlich.' };
    }

    // Get admin's service config
    const adminService = await this.userRepo.getService(admin.id, serviceType, serviceName);
    if (!adminService) {
      return { success: false, error: `Service "${serviceName}" (${serviceType}) nicht bei dir konfiguriert.` };
    }

    // Find target user
    const target = await this.userRepo.getByUsername(targetUsername);
    if (!target) return { success: false, error: `User "${targetUsername}" nicht gefunden.` };

    // Build shared config: copy admin credentials but point to shared resource
    const config = { ...(adminService.config as Record<string, unknown>) };

    if (config.provider === 'microsoft' || config.microsoft) {
      // Microsoft 365: shared_resource is REQUIRED to prevent leaking admin's own account
      if (!sharedResource) {
        return {
          success: false,
          error: 'shared_resource (Email-Adresse des freigegebenen Postfachs/Kalenders) ist erforderlich für Microsoft 365. ' +
            'Beispiel: shared_resource: "office@firma.at". Ohne shared_resource würde dein eigener Account freigegeben werden.',
        };
      }
      // Set the shared resource path based on service type
      const ms = (config.microsoft ?? config) as Record<string, unknown>;
      if (serviceType === 'email') ms.sharedMailbox = sharedResource;
      else if (serviceType === 'calendar') ms.sharedCalendar = sharedResource;
      else if (serviceType === 'todo') ms.sharedUser = sharedResource;
      else if (serviceType === 'contacts') ms.sharedUser = sharedResource;
      if (config.microsoft) config.microsoft = ms;
    } else if (sharedResource) {
      // Non-Microsoft: shared_resource is informational only
      config.sharedResource = sharedResource;
    }

    await this.userRepo.addService(target.id, serviceType, serviceName, config);

    const sharedInfo = sharedResource ? ` (Shared Resource: ${sharedResource})` : '';
    return {
      success: true,
      display: `✅ Service "${serviceName}" (${serviceType}) mit ${targetUsername} geteilt${sharedInfo}.\n\n` +
        (sharedResource
          ? `${targetUsername} greift auf die freigegebene Ressource "${sharedResource}" zu, NICHT auf deinen persönlichen Account.`
          : `Hinweis: Die Konfiguration wurde 1:1 kopiert.`),
    };
  }
}
