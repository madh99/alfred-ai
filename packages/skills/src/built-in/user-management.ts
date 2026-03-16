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
  ],
  family: [
    'calculator', 'weather', 'web_search', 'reminder', 'note', 'todo',
    'memory', 'email', 'calendar', 'contacts', 'routing', 'transit',
    'energy_price', 'briefing', 'youtube', 'feed_reader', 'user_management', 'help',
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
- setup_service: Configure a personal service (email, calendar, bmw). Params: service_type, service_name, config (JSON with credentials)
- my_services: List your configured services
- remove_service: Remove a personal service. Params: service_type, service_name
- share_service: Share a service with another user (admin only). Params: username, service_type, service_name`,
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_user', 'list_users', 'set_role', 'deactivate', 'activate', 'delete', 'invite', 'whoami', 'connect', 'setup_service', 'my_services', 'remove_service', 'share_service'],
        },
        username: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'user', 'family', 'guest', 'service'] },
        displayName: { type: 'string' },
        code: { type: 'string', description: 'Invite code (for connect action)' },
        service_type: { type: 'string', description: 'Service type: email, calendar, bmw, contacts, todo' },
        service_name: { type: 'string', description: 'Service name (e.g. "outlook", "gmail", "google-calendar")' },
        config: { type: 'object', description: 'Service config JSON (credentials, endpoints)' },
        target_username: { type: 'string', description: 'Target username for sharing' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly userRepo: AlfredUserRepository) {
    super();
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
    if (!serviceName) return { success: false, error: 'service_name ist erforderlich (z.B. "outlook", "gmail", "google-calendar").' };
    if (!config || typeof config !== 'object') return { success: false, error: 'config ist erforderlich (JSON mit Zugangsdaten).' };

    const validTypes = ['email', 'calendar', 'bmw', 'contacts', 'todo'];
    if (!validTypes.includes(serviceType)) {
      return { success: false, error: `Ungültiger service_type. Erlaubt: ${validTypes.join(', ')}` };
    }

    await context.userServiceResolver.saveServiceConfig(callerUser.id, serviceType, serviceName, config);

    return {
      success: true,
      data: { serviceType, serviceName },
      display: `✅ Service "${serviceName}" (${serviceType}) konfiguriert.\n\nDeine persönliche ${serviceType}-Konfiguration wird ab sofort verwendet.`,
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

  // ── Service Sharing (admin only) ───────────────────────────

  private async shareService(
    input: Record<string, unknown>,
    admin: { id: string },
  ): Promise<SkillResult> {
    const targetUsername = (input.target_username ?? input.username) as string;
    const serviceType = input.service_type as string;
    const serviceName = input.service_name as string;

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

    // Copy the service config to the target user
    await this.userRepo.addService(target.id, serviceType, serviceName, adminService.config);

    return {
      success: true,
      display: `✅ Service "${serviceName}" (${serviceType}) mit ${targetUsername} geteilt.`,
    };
  }
}
