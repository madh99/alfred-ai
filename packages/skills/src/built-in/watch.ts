import type { SkillMetadata, SkillContext, SkillResult, WatchCondition } from '@alfred/types';
import { Skill } from '../skill.js';
import type { WatchRepository } from '@alfred/storage';

type WatchAction = 'create' | 'list' | 'enable' | 'disable' | 'delete';

const VALID_OPERATORS: WatchCondition['operator'][] = [
  'lt', 'gt', 'lte', 'gte', 'eq', 'neq',
  'contains', 'not_contains', 'changed', 'increased', 'decreased',
];

export class WatchSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'watch',
    category: 'automation',
    description:
      'Create and manage condition-based alerts (watches). ' +
      'A watch polls a skill at regular intervals, extracts a field from the result, and sends a notification when a condition is met — no LLM involved. ' +
      'Operators: lt, gt, lte, gte (numeric), eq, neq (string), contains, not_contains (substring), changed, increased, decreased (vs. last value). ' +
      'The first check stores a baseline and never triggers. ' +
      'Common condition_field paths by skill: ' +
      'energy_prices → "bruttoCt" (current price ct/kWh); ' +
      'bmw {action:"status"} → "telematic.CHARGING_STATUS.value", "telematic.BATTERY_SIZE_MAX.value"; ' +
      'todo {action:"list",list:"..."} → use "length" for item count; ' +
      'email {action:"inbox"} → "unreadCount" or "messages.length"; ' +
      'monitor → returns alerts array, use "length" with gt 0. ' +
      'Use scheduled_task instead when you need to run a prompt through the LLM or when the user asks for a time-based report rather than a condition-based alert.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'enable', 'disable', 'delete'],
          description: 'The watch action to perform',
        },
        name: {
          type: 'string',
          description: 'Short description of the watch (for create)',
        },
        skill_name: {
          type: 'string',
          description: 'Which skill to poll, e.g. "energy_prices", "email_list", "bmw" (for create)',
        },
        skill_params: {
          type: 'object',
          description: 'Parameters to pass to the skill (for create)',
        },
        condition_field: {
          type: 'string',
          description: 'Dot-path to extract from skill result data, e.g. "brutto_ct", "items.length", "battery.level" (for create)',
        },
        condition_operator: {
          type: 'string',
          enum: ['lt', 'gt', 'lte', 'gte', 'eq', 'neq', 'contains', 'not_contains', 'changed', 'increased', 'decreased'],
          description: 'Comparison operator (for create)',
        },
        condition_value: {
          type: ['string', 'number'],
          description: 'Threshold value — optional for changed/increased/decreased (for create)',
        },
        interval_minutes: {
          type: 'number',
          description: 'Poll interval in minutes (default 15) (for create)',
        },
        cooldown_minutes: {
          type: 'number',
          description: 'Minimum minutes between alerts (default 30) (for create)',
        },
        message_template: {
          type: 'string',
          description: 'Custom alert message (for create)',
        },
        watch_id: {
          type: 'string',
          description: 'Watch ID (for enable, disable, delete)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly watchRepo: WatchRepository) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as WatchAction;

    switch (action) {
      case 'create':
        return this.createWatch(input, context);
      case 'list':
        return this.listWatches(context);
      case 'enable':
        return this.toggleWatch(input, true);
      case 'disable':
        return this.toggleWatch(input, false);
      case 'delete':
        return this.deleteWatch(input);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid: create, list, enable, disable, delete`,
        };
    }
  }

  private createWatch(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const name = input.name as string | undefined;
    const skillName = input.skill_name as string | undefined;
    const skillParams = (input.skill_params as Record<string, unknown>) ?? {};
    const conditionField = input.condition_field as string | undefined;
    const conditionOperator = input.condition_operator as string | undefined;
    const conditionValue = input.condition_value as string | number | undefined;
    const intervalMinutes = (input.interval_minutes as number) ?? 15;
    const cooldownMinutes = (input.cooldown_minutes as number) ?? 30;
    const messageTemplate = input.message_template as string | undefined;

    if (!name) return { success: false, error: 'Missing required field "name"' };
    if (!skillName) return { success: false, error: 'Missing required field "skill_name"' };
    if (!conditionField) return { success: false, error: 'Missing required field "condition_field"' };
    if (!conditionOperator || !VALID_OPERATORS.includes(conditionOperator as WatchCondition['operator'])) {
      return { success: false, error: `Invalid "condition_operator". Must be one of: ${VALID_OPERATORS.join(', ')}` };
    }
    if (intervalMinutes < 1) return { success: false, error: 'interval_minutes must be >= 1' };
    if (cooldownMinutes < 0) return { success: false, error: 'cooldown_minutes must be >= 0' };

    const watch = this.watchRepo.create({
      chatId: context.chatId,
      platform: context.platform,
      name,
      skillName,
      skillParams,
      condition: {
        field: conditionField,
        operator: conditionOperator as WatchCondition['operator'],
        value: conditionValue,
      },
      intervalMinutes,
      cooldownMinutes,
      enabled: true,
      messageTemplate,
    });

    return {
      success: true,
      data: { watchId: watch.id, name, skillName, conditionField, conditionOperator, conditionValue, intervalMinutes },
      display: `Watch erstellt (${watch.id}): "${name}" — pollt "${skillName}" alle ${intervalMinutes}min, Bedingung: ${conditionField} ${conditionOperator}${conditionValue != null ? ' ' + conditionValue : ''}`,
    };
  }

  private listWatches(context: SkillContext): SkillResult {
    const watches = this.watchRepo.findByChatId(context.chatId, context.platform);

    if (watches.length === 0) {
      return { success: true, data: [], display: 'Keine Watches vorhanden.' };
    }

    const lines = watches.map((w) => {
      const status = w.enabled ? '\u2705' : '\u23F8\uFE0F';
      const condStr = `${w.condition.field} ${w.condition.operator}${w.condition.value != null ? ' ' + w.condition.value : ''}`;
      const lastCheck = w.lastCheckedAt ? ` | letzter Check: ${w.lastCheckedAt}` : '';
      return `- ${status} ${w.id}: "${w.name}" [${w.skillName}, ${w.intervalMinutes}min] ${condStr}${lastCheck}`;
    });

    return {
      success: true,
      data: watches.map((w) => ({
        watchId: w.id,
        name: w.name,
        skillName: w.skillName,
        condition: w.condition,
        intervalMinutes: w.intervalMinutes,
        enabled: w.enabled,
        lastCheckedAt: w.lastCheckedAt,
        lastTriggeredAt: w.lastTriggeredAt,
      })),
      display: `Watches:\n${lines.join('\n')}`,
    };
  }

  private toggleWatch(input: Record<string, unknown>, enabled: boolean): SkillResult {
    const watchId = input.watch_id as string | undefined;
    if (!watchId) return { success: false, error: `Missing "watch_id" for ${enabled ? 'enable' : 'disable'}` };

    const updated = this.watchRepo.toggle(watchId, enabled);
    if (!updated) return { success: false, error: `Watch "${watchId}" not found` };

    return {
      success: true,
      data: { watchId, enabled },
      display: `Watch "${watchId}" ${enabled ? 'aktiviert' : 'deaktiviert'}.`,
    };
  }

  private deleteWatch(input: Record<string, unknown>): SkillResult {
    const watchId = input.watch_id as string | undefined;
    if (!watchId) return { success: false, error: 'Missing "watch_id" for delete' };

    const deleted = this.watchRepo.delete(watchId);
    if (!deleted) return { success: false, error: `Watch "${watchId}" not found` };

    return {
      success: true,
      data: { watchId },
      display: `Watch "${watchId}" gelöscht.`,
    };
  }
}
