import type { SkillContext } from '@alfred/types';

/** Resolve effective user ID: cross-platform master if linked, else current user. */
export function effectiveUserId(context: SkillContext): string {
  return context.masterUserId ?? context.userId;
}

/** All user IDs to query — includes masterUserId, current platform userId,
 *  and all linked platform user IDs for backward compat with old data. */
export function allUserIds(context: SkillContext): string[] {
  const set = new Set<string>();
  set.add(effectiveUserId(context));
  set.add(context.userId);
  if (context.linkedPlatformUserIds) {
    for (const id of context.linkedPlatformUserIds) set.add(id);
  }
  return [...set];
}
