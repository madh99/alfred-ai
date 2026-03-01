import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { UserRepository } from '@alfred/storage';

type ProfileAction = 'get' | 'set_timezone' | 'set_language' | 'set_bio' | 'set_preference';

export class ProfileSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'profile',
    description:
      'Manage user profile settings including timezone, language, and bio. ' +
      'Use this to personalize Alfred for each user.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set_timezone', 'set_language', 'set_bio', 'set_preference'],
          description: 'The profile action to perform',
        },
        value: {
          type: 'string',
          description: 'The value to set (for set_* actions)',
        },
        preference_key: {
          type: 'string',
          description: 'The preference key (for set_preference)',
        },
        preference_value: {
          type: 'string',
          description: 'The preference value (for set_preference)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly userRepo: UserRepository) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as ProfileAction;
    // Resolve internal user ID — use master user for cross-platform linked accounts
    const currentUser = this.userRepo.findOrCreate(
      context.platform as any,
      context.userId,
    );
    const masterInternalId = 'getMasterUserId' in this.userRepo
      ? (this.userRepo as any).getMasterUserId(currentUser.id) as string
      : currentUser.id;
    const user = ('findById' in this.userRepo
      ? (this.userRepo as any).findById(masterInternalId)
      : currentUser) ?? currentUser;

    switch (action) {
      case 'get':
        return this.getProfile(user.id);
      case 'set_timezone':
        return this.setField(user.id, 'timezone', input.value as string);
      case 'set_language':
        return this.setField(user.id, 'language', input.value as string);
      case 'set_bio':
        return this.setField(user.id, 'bio', input.value as string);
      case 'set_preference':
        return this.setPreference(user.id, input.preference_key as string, input.preference_value as string);
      default:
        return { success: false, error: `Unknown action: "${String(action)}"` };
    }
  }

  private getProfile(userId: string): SkillResult {
    const profile = (this.userRepo as any).getProfile(userId);
    if (!profile) {
      return { success: true, data: null, display: 'No profile found. Set your timezone, language, or bio to create one.' };
    }

    const parts: string[] = [];
    if (profile.displayName) parts.push(`Name: ${profile.displayName}`);
    if (profile.timezone) parts.push(`Timezone: ${profile.timezone}`);
    if (profile.language) parts.push(`Language: ${profile.language}`);
    if (profile.bio) parts.push(`Bio: ${profile.bio}`);
    if (profile.preferences) {
      for (const [key, value] of Object.entries(profile.preferences)) {
        parts.push(`${key}: ${String(value)}`);
      }
    }

    return {
      success: true,
      data: profile,
      display: parts.length > 0 ? `Profile:\n${parts.map(p => `- ${p}`).join('\n')}` : 'Profile is empty.',
    };
  }

  private setField(userId: string, field: 'timezone' | 'language' | 'bio', value: string): SkillResult {
    if (!value || typeof value !== 'string') {
      return { success: false, error: `Missing required "value" for ${field}` };
    }
    (this.userRepo as any).updateProfile(userId, { [field]: value });
    return { success: true, data: { [field]: value }, display: `${field} set to "${value}"` };
  }

  private setPreference(userId: string, key: string, value: string): SkillResult {
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'Missing required "preference_key"' };
    }
    const profile = (this.userRepo as any).getProfile(userId);
    const prefs = profile?.preferences ?? {};
    prefs[key] = value;
    (this.userRepo as any).updateProfile(userId, { preferences: prefs });
    return { success: true, data: { key, value }, display: `Preference "${key}" set to "${value}"` };
  }
}
