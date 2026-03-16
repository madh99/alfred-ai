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
    'energy_price', 'marketplace', 'briefing', 'delegate', 'user_management',
  ],
  family: [
    'calculator', 'weather', 'web_search', 'reminder', 'note', 'todo',
    'memory', 'email', 'calendar', 'contacts', 'routing', 'transit',
    'energy_price', 'briefing', 'youtube', 'feed_reader', 'user_management',
  ],
  guest: [
    'calculator', 'weather', 'web_search', 'routing', 'transit',
    'energy_price', 'youtube', 'user_management',
  ],
  service: [
    'calculator', 'weather', 'web_search', 'user_management',
  ],
};

export { ROLE_SKILL_ACCESS };

export class UserManagementSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'user_management',
    category: 'identity',
    description: `Manage Alfred users. Admin-only actions: create_user, list_users, set_role, deactivate, activate, delete. Any user: whoami, connect (use invite code to link platform account).
Actions:
- create_user: Create a new user (admin only). Params: username, role (admin|user|family|guest), displayName
- list_users: List all users (admin only)
- set_role: Change user role (admin only). Params: username, role
- deactivate: Deactivate a user (admin only). Params: username
- activate: Reactivate a user (admin only). Params: username
- delete: Delete a user (admin only). Params: username
- invite: Regenerate invite code (admin only). Params: username
- whoami: Show current user info
- connect: Connect platform with invite code. Params: code`,
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_user', 'list_users', 'set_role', 'deactivate', 'activate', 'delete', 'invite', 'whoami', 'connect'],
        },
        username: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'user', 'family', 'guest', 'service'] },
        displayName: { type: 'string' },
        code: { type: 'string', description: 'Invite code (for connect action)' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly userRepo: AlfredUserRepository) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;
    const callerUser = this.userRepo.getUserByPlatform(context.platform, context.userId);

    switch (action) {
      case 'whoami':
        return this.whoami(context, callerUser);
      case 'connect':
        return this.connectPlatform(input, context);
      case 'create_user':
      case 'list_users':
      case 'set_role':
      case 'deactivate':
      case 'activate':
      case 'delete':
      case 'invite':
        // Admin-only actions
        if (!callerUser || callerUser.role !== 'admin') {
          return { success: false, error: 'Nur Admins können User verwalten.' };
        }
        return this.adminAction(action, input, callerUser);
      default:
        return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private whoami(context: SkillContext, user: ReturnType<AlfredUserRepository['getUserByPlatform']>): SkillResult {
    if (!user) {
      return {
        success: true,
        data: { registered: false, platform: context.platform, platformUserId: context.userId },
        display: `Du bist noch nicht als Alfred-User registriert.\nPlattform: ${context.platform}\nUser-ID: ${context.userId}\n\nSage "connect" mit einem Invite-Code um dich zu verbinden.`,
      };
    }

    const links = this.userRepo.getPlatformLinks(user.id);
    const services = this.userRepo.getServices(user.id);

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

  private connectPlatform(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const code = input.code as string;
    if (!code) return { success: false, error: 'Bitte Invite-Code angeben.' };

    // Atomic: verify code + link platform + clear code (prevents race condition)
    const existing = this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (existing) {
      return { success: false, error: `Diese ${context.platform}-ID ist bereits mit User "${existing.username}" verbunden.` };
    }

    const user = this.userRepo.consumeInviteCode(code, context.platform, context.userId);
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

  private adminAction(action: string, input: Record<string, unknown>, admin: { id: string }): SkillResult {
    switch (action) {
      case 'create_user': {
        const username = input.username as string;
        const role = (input.role as UserRole) ?? 'user';
        const displayName = input.displayName as string | undefined;
        if (!username) return { success: false, error: 'Username fehlt.' };
        if (!VALID_ROLES.includes(role)) return { success: false, error: `Ungültige Rolle: ${role}. Erlaubt: ${VALID_ROLES.join(', ')}` };

        const existing = this.userRepo.getByUsername(username);
        if (existing) return { success: false, error: `User "${username}" existiert bereits.` };

        const user = this.userRepo.create({ username, role, displayName, createdBy: admin.id });

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
        const users = this.userRepo.getAll();
        if (users.length === 0) return { success: true, data: [], display: 'Keine User angelegt.' };

        const lines = users.map(u => {
          const links = this.userRepo.getPlatformLinks(u.id);
          const platforms = links.map(l => l.platform).join(', ') || '—';
          return `• **${u.username}** (${u.role}) — ${u.active ? '✅' : '❌'} — Plattformen: ${platforms}${u.inviteCode ? ` — Code: ${u.inviteCode}` : ''}`;
        });

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

        const user = this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };

        this.userRepo.updateRole(user.id, role);
        return { success: true, data: { username, role }, display: `✅ Rolle von "${username}" auf "${role}" geändert.` };
      }

      case 'deactivate': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        this.userRepo.deactivate(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" deaktiviert.` };
      }

      case 'activate': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        this.userRepo.activate(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" aktiviert.` };
      }

      case 'delete': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        this.userRepo.delete(user.id);
        return { success: true, data: { username }, display: `✅ User "${username}" gelöscht.` };
      }

      case 'invite': {
        const username = input.username as string;
        if (!username) return { success: false, error: 'Username fehlt.' };
        const user = this.userRepo.getByUsername(username);
        if (!user) return { success: false, error: `User "${username}" nicht gefunden.` };
        const code = this.userRepo.regenerateInviteCode(user.id);
        return { success: true, data: { username, inviteCode: code }, display: `✅ Neuer Invite-Code für "${username}": **${code}** (24h gültig)` };
      }

      default:
        return { success: false, error: `Unbekannte Admin-Aktion: ${action}` };
    }
  }
}
