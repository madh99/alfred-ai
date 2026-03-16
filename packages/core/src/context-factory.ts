import type { SkillContext, Platform } from '@alfred/types';
import type { UserRepository } from '@alfred/storage';

/** Input describing where the request originates from. */
export interface ContextSource {
  /** Platform user ID — used by message-pipeline (direct platform ID). */
  platformUserId?: string;
  /** Internal user ID — used by background/scheduled tasks (may be UUID). */
  userId?: string;
  platform: Platform | string;
  chatId: string;
  chatType?: string;
  conversationId?: string;
  userName?: string;
  displayName?: string;
}

/** Result of building a SkillContext including resolved user data. */
export interface ContextResult {
  context: SkillContext;
  user: { id: string; platformUserId: string; username?: string; displayName?: string };
  masterUserId: string;
  linkedPlatformUserIds: string[];
}

// UserRepository may or may not expose cross-platform helpers depending on the
// concrete implementation.  We use type-guards rather than requiring them so the
// factory stays backwards-compatible with minimal test mocks.
type UsersWithCrossPlatform = UserRepository & {
  getMasterUserId(id: string): Promise<string>;
  getLinkedUsers(masterId: string): Promise<{ platformUserId: string }[]>;
  getProfile(id: string): Promise<{ timezone?: string } | undefined>;
};

/**
 * Build a SkillContext from a ContextSource — centralises user-lookup,
 * master-resolution and timezone logic previously duplicated across
 * message-pipeline, background-task-runner and proactive-scheduler.
 */
export async function buildSkillContext(
  users: UserRepository,
  source: ContextSource,
): Promise<ContextResult> {
  // 1. Resolve user
  let user: { id: string; platformUserId: string; username?: string; displayName?: string };
  if (source.platformUserId) {
    user = await users.findOrCreate(
      source.platform as Platform,
      source.platformUserId,
      source.userName,
      source.displayName,
    );
  } else if (source.userId) {
    // Try internal lookup first to avoid creating phantom users.
    const existing = await users.findById(source.userId);
    user = existing ?? await users.findOrCreate(source.platform as Platform, source.userId);
  } else {
    throw new Error('ContextSource must provide either platformUserId or userId');
  }

  // 2. Resolve master user for cross-platform shared context
  const masterUserId = 'getMasterUserId' in users
    ? await (users as UsersWithCrossPlatform).getMasterUserId(user.id)
    : user.id;

  // 3. Resolve all linked platform user IDs
  let linkedPlatformUserIds: string[] = [];
  if ('getLinkedUsers' in users) {
    const linked = await (users as UsersWithCrossPlatform).getLinkedUsers(masterUserId);
    linkedPlatformUserIds = linked.map(u => u.platformUserId);
  }

  // 4. Resolve timezone from user profile (fallback: server timezone)
  let timezone: string | undefined;
  try {
    if ('getProfile' in users) {
      const profile = await (users as UsersWithCrossPlatform).getProfile(masterUserId);
      timezone = profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  } catch {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // 5. Build context
  const context: SkillContext = {
    userId: user.platformUserId,
    masterUserId,
    linkedPlatformUserIds,
    chatId: source.chatId,
    chatType: source.chatType,
    platform: source.platform as string,
    conversationId: source.conversationId ?? '',
    timezone,
  };

  return { context, user, masterUserId, linkedPlatformUserIds };
}
