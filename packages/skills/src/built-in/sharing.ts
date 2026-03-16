import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { SharedResourceRepository, AlfredUserRepository } from '@alfred/storage';

export class SharingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'sharing',
    category: 'identity',
    description: `Share resources between users. Admin can share todo lists, database connections, etc. with other users or groups.
Actions:
- share: Share a resource. Params: resourceType (todo_list|db_connection|calendar), resourceId (name), username (target user)
- unshare: Remove sharing. Params: resourceType, resourceId, username
- list_shared: List all shared resources
- my_shared: Show resources shared with me`,
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['share', 'unshare', 'list_shared', 'my_shared'] },
        resourceType: { type: 'string', enum: ['todo_list', 'db_connection', 'calendar'], description: 'Type of resource to share' },
        resourceId: { type: 'string', description: 'Resource name/ID (e.g. todo list name, db connection name)' },
        username: { type: 'string', description: 'Username to share with' },
        groupId: { type: 'string', description: 'Group/chat ID to share with (alternative to username)' },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly sharingRepo: SharedResourceRepository,
    private readonly userRepo: AlfredUserRepository,
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'share': return this.shareResource(input, context);
      case 'unshare': return this.unshareResource(input, context);
      case 'list_shared': return this.listShared(context);
      case 'my_shared': return this.myShared(context);
      default: return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private shareResource(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const resourceType = input.resourceType as string;
    const resourceId = input.resourceId as string;
    const username = input.username as string | undefined;
    const groupId = input.groupId as string | undefined;

    if (!resourceType || !resourceId) return { success: false, error: 'resourceType und resourceId erforderlich.' };
    if (!username && !groupId) return { success: false, error: 'username oder groupId erforderlich.' };

    // Check caller is admin or owner
    const caller = this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (!caller || (caller.role !== 'admin')) {
      return { success: false, error: 'Nur Admins können Ressourcen teilen.' };
    }

    let targetUserId: string | undefined;
    if (username) {
      const target = this.userRepo.getByUsername(username);
      if (!target) return { success: false, error: `User "${username}" nicht gefunden.` };
      targetUserId = target.id;
    }

    this.sharingRepo.share({
      resourceType,
      resourceId,
      ownerUserId: caller.id,
      sharedWithUserId: targetUserId,
      sharedWithGroupId: groupId,
    });

    const sharedWith = username ? `User "${username}"` : `Gruppe ${groupId}`;
    return {
      success: true,
      data: { resourceType, resourceId, sharedWith },
      display: `✅ ${resourceType} "${resourceId}" mit ${sharedWith} geteilt.`,
    };
  }

  private unshareResource(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const resourceType = input.resourceType as string;
    const resourceId = input.resourceId as string;
    const username = input.username as string | undefined;
    const groupId = input.groupId as string | undefined;

    if (!resourceType || !resourceId) return { success: false, error: 'resourceType und resourceId erforderlich.' };

    const caller = this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (!caller || caller.role !== 'admin') return { success: false, error: 'Nur Admins.' };

    let targetUserId: string | undefined;
    if (username) {
      const target = this.userRepo.getByUsername(username);
      if (target) targetUserId = target.id;
    }

    const removed = this.sharingRepo.unshare(resourceType, resourceId, targetUserId, groupId);
    return removed
      ? { success: true, data: { resourceType, resourceId }, display: `✅ Sharing für "${resourceId}" entfernt.` }
      : { success: false, error: `Kein Sharing gefunden für "${resourceId}".` };
  }

  private listShared(context: SkillContext): SkillResult {
    const caller = this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (!caller || caller.role !== 'admin') return { success: false, error: 'Nur Admins.' };

    const allUsers = this.userRepo.getAll();
    const shares: Array<{ type: string; id: string; with: string }> = [];

    for (const user of allUsers) {
      const userShares = this.sharingRepo.getSharedWith(user.id);
      for (const s of userShares) {
        shares.push({ type: s.resourceType, id: s.resourceId, with: user.username });
      }
    }

    if (shares.length === 0) return { success: true, data: [], display: 'Keine geteilten Ressourcen.' };

    const display = shares.map(s => `• ${s.type} "${s.id}" → ${s.with}`).join('\n');
    return { success: true, data: shares, display: `**Geteilte Ressourcen (${shares.length}):**\n${display}` };
  }

  private myShared(context: SkillContext): SkillResult {
    const caller = this.userRepo.getUserByPlatform(context.platform, context.userId);
    if (!caller) return { success: true, data: [], display: 'Nicht registriert — keine geteilten Ressourcen.' };

    const shared = this.sharingRepo.getSharedWith(caller.id);
    if (shared.length === 0) return { success: true, data: [], display: 'Keine Ressourcen mit dir geteilt.' };

    const display = shared.map(s => `• ${s.resourceType} "${s.resourceId}" (von ${s.ownerUserId})`).join('\n');
    return { success: true, data: shared, display: `**Mit dir geteilte Ressourcen (${shared.length}):**\n${display}` };
  }
}
