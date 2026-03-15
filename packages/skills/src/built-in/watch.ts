import type { SkillMetadata, SkillContext, SkillResult, WatchCondition, CompositeCondition, Watch } from '@alfred/types';
import { Skill } from '../skill.js';
import type { SkillRegistry } from '../skill-registry.js';
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
      'IMPORTANT: skill_params must contain ALL parameters the target skill needs (action, query, etc.). The watch engine calls the skill with ONLY skill_params as input. ' +
      'Common condition_field paths by skill: ' +
      'marketplace {action:"search", query:"...", platform:"willhaben"} → "minPrice" (lt for price drop), "count" (increased for new listings); ' +
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
          description: 'COMPLETE parameters object passed to the skill. Must include ALL required fields (e.g. {action:"search", query:"RTX 5090", platform:"willhaben"} for marketplace). The watch engine calls the skill with ONLY this object.',
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
        action_skill_name: {
          type: 'string',
          description: 'Skill to execute when condition triggers (for create). Enables automation: watch detects condition → executes action.',
        },
        action_skill_params: {
          type: 'object',
          description: 'Parameters for the action skill (for create)',
        },
        action_on_trigger: {
          type: 'string',
          enum: ['alert', 'action_only', 'alert_and_action', 'trigger_watch'],
          description: 'What to do on trigger: alert (default), action_only, alert_and_action, or trigger_watch to chain watches (for create)',
        },
        trigger_watch_id: {
          type: 'string',
          description: 'ID of another watch to trigger when this watch fires. Use with action_on_trigger: "trigger_watch" to create watch chains (A fires → immediately evaluates B).',
        },
        requires_confirmation: {
          type: 'boolean',
          description: 'If true, action requires user confirmation before execution (for create)',
        },
        conditions: {
          type: 'array',
          description: 'Array of conditions for composite logic (alternative to single condition_field/operator/value). Each: {field, operator, value?}',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string', enum: ['lt', 'gt', 'lte', 'gte', 'eq', 'neq', 'contains', 'not_contains', 'changed', 'increased', 'decreased'] },
              value: { type: ['string', 'number'] },
            },
            required: ['field', 'operator'],
          },
        },
        conditions_logic: {
          type: 'string',
          enum: ['and', 'or'],
          description: 'Logic for composite conditions: "and" (all must match) or "or" (any must match). Default: "and"',
        },
        watch_id: {
          type: 'string',
          description: 'Watch ID (for enable, disable, delete)',
        },
      },
      required: ['action'],
    },
  };

  private skillRegistry: SkillRegistry | null = null;

  constructor(private readonly watchRepo: WatchRepository, skillRegistry?: SkillRegistry) {
    super();
    this.skillRegistry = skillRegistry ?? null;
  }

  /** Allow late binding when registry isn't available at construction time. */
  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
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
    const actionSkillName = input.action_skill_name as string | undefined;
    const actionSkillParams = input.action_skill_params as Record<string, unknown> | undefined;
    const actionOnTrigger = (input.action_on_trigger as Watch['actionOnTrigger']) ?? 'alert';
    const requiresConfirmation = input.requires_confirmation as boolean | undefined;
    const triggerWatchId = input.trigger_watch_id as string | undefined;
    const conditionsArray = input.conditions as Array<{ field: string; operator: string; value?: string | number }> | undefined;
    const conditionsLogic = (input.conditions_logic as 'and' | 'or') ?? 'and';

    if (!name) return { success: false, error: 'Missing required field "name"' };
    if (!skillName) return { success: false, error: 'Missing required field "skill_name"' };

    // Validate: either single condition or conditions array must be provided
    const hasComposite = Array.isArray(conditionsArray) && conditionsArray.length > 0;
    const hasSingle = !!conditionField && !!conditionOperator;

    if (!hasComposite && !hasSingle) {
      return { success: false, error: 'Missing conditions: provide either "condition_field"+"condition_operator" or a "conditions" array' };
    }

    // Validate composite conditions
    let compositeCondition: CompositeCondition | undefined;
    if (hasComposite) {
      for (const cond of conditionsArray!) {
        if (!cond.field || !cond.operator) {
          return { success: false, error: 'Each condition must have "field" and "operator"' };
        }
        if (!VALID_OPERATORS.includes(cond.operator as WatchCondition['operator'])) {
          return { success: false, error: `Invalid operator "${cond.operator}" in conditions. Must be one of: ${VALID_OPERATORS.join(', ')}` };
        }
      }
      compositeCondition = {
        logic: conditionsLogic,
        conditions: conditionsArray!.map((c) => ({
          field: c.field,
          operator: c.operator as WatchCondition['operator'],
          value: c.value,
        })),
      };
    }

    if (hasSingle && !VALID_OPERATORS.includes(conditionOperator as WatchCondition['operator'])) {
      return { success: false, error: `Invalid "condition_operator". Must be one of: ${VALID_OPERATORS.join(', ')}` };
    }
    if (intervalMinutes < 1) return { success: false, error: 'interval_minutes must be >= 1' };
    if (cooldownMinutes < 0) return { success: false, error: 'cooldown_minutes must be >= 0' };

    // Validate trigger_watch chain
    if (actionOnTrigger === 'trigger_watch' && !triggerWatchId) {
      return { success: false, error: 'Missing "trigger_watch_id" — required when action_on_trigger is "trigger_watch"' };
    }
    if (triggerWatchId && !this.watchRepo.getById(triggerWatchId)) {
      return { success: false, error: `Chained watch "${triggerWatchId}" does not exist` };
    }

    // Validate skill_params against target skill's required fields
    if (this.skillRegistry) {
      const targetSkill = this.skillRegistry.get(skillName);
      if (!targetSkill) {
        return { success: false, error: `Unknown skill "${skillName}". The skill must be registered before creating a watch.` };
      }
      const schema = targetSkill.metadata.inputSchema;
      if (schema && Array.isArray(schema.required)) {
        const missing = schema.required.filter((field: string) => !(field in skillParams));
        if (missing.length > 0) {
          return {
            success: false,
            error: `skill_params is missing required fields for "${skillName}": ${missing.join(', ')}. ` +
              `skill_params must contain the COMPLETE input for the skill. ` +
              `Expected: ${JSON.stringify(schema.required)}`,
          };
        }
      }
    }

    // Build the primary condition — use first composite condition as fallback for the required single condition
    const primaryField = conditionField ?? (compositeCondition ? compositeCondition.conditions[0].field : '');
    const primaryOperator = (conditionOperator ?? (compositeCondition ? compositeCondition.conditions[0].operator : 'changed')) as WatchCondition['operator'];
    const primaryValue = conditionValue ?? (compositeCondition ? compositeCondition.conditions[0].value : undefined);

    const watch = this.watchRepo.create({
      chatId: context.chatId,
      platform: context.platform,
      name,
      skillName,
      skillParams,
      condition: {
        field: primaryField,
        operator: primaryOperator,
        value: primaryValue,
      },
      intervalMinutes,
      cooldownMinutes,
      enabled: true,
      messageTemplate,
      compositeCondition,
      actionSkillName,
      actionSkillParams,
      actionOnTrigger,
      requiresConfirmation,
      triggerWatchId,
    });

    const condDisplay = compositeCondition
      ? `${compositeCondition.logic.toUpperCase()}(${compositeCondition.conditions.map((c) => `${c.field} ${c.operator}${c.value != null ? ' ' + c.value : ''}`).join(', ')})`
      : `${primaryField} ${primaryOperator}${primaryValue != null ? ' ' + primaryValue : ''}`;

    const actionDisplay = triggerWatchId
      ? ` → Chain → Watch ${triggerWatchId}`
      : actionSkillName ? ` → Aktion: ${actionSkillName} (${actionOnTrigger})` : '';

    return {
      success: true,
      data: { watchId: watch.id, name, skillName, conditionField: primaryField, conditionOperator: primaryOperator, conditionValue: primaryValue, intervalMinutes, compositeCondition, triggerWatchId },
      display: `Watch erstellt (${watch.id}): "${name}" — pollt "${skillName}" alle ${intervalMinutes}min, Bedingung: ${condDisplay}${actionDisplay}`,
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
      const actionInfo = w.actionSkillName ? ` → Aktion: ${w.actionSkillName}` : '';
      return `- ${status} ${w.id}: "${w.name}" [${w.skillName}, ${w.intervalMinutes}min] ${condStr}${actionInfo}${lastCheck}`;
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
