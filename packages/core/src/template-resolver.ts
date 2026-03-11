import { extractField } from './condition-evaluator.js';

/**
 * Resolve {{path.to.field}} placeholders against a context object.
 * Uses extractField from condition-evaluator for dot-path resolution.
 */
export function resolveTemplates(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const value = extractField(context, path.trim());
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Deep-resolve template strings in an object tree.
 * Only string values are resolved; other types pass through unchanged.
 */
export function resolveTemplatesInObject(
  obj: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = resolveTemplates(value, context);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = resolveTemplatesInObject(value as Record<string, unknown>, context);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') return resolveTemplates(item, context);
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          return resolveTemplatesInObject(item as Record<string, unknown>, context);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}
