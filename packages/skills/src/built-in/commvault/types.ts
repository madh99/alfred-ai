/**
 * Commvault Skill — Shared types and helpers
 */

export interface CommvaultApiClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: Record<string, unknown>): Promise<T>;
  put<T = any>(path: string, body?: Record<string, unknown>): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
}

export type SkillResult = { success: boolean; data?: any; display?: string; error?: string };

/** Format megabytes into human-readable size string (MB / GB / TB). */
export function formatSize(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Calculate usage percentage. Returns 0 when total is 0. */
export function usagePct(totalMB: number, freeMB: number): number {
  return totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;
}

/** Safely extract an integer from input record. */
export function requireId(input: Record<string, unknown>, key: string): number {
  const val = input[key];
  if (val === undefined || val === null) throw new Error(`Parameter "${key}" ist erforderlich`);
  const num = typeof val === 'number' ? val : parseInt(String(val), 10);
  if (isNaN(num)) throw new Error(`Parameter "${key}" muss eine Zahl sein`);
  return num;
}

/** Safely extract an optional string from input record. */
export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const val = input[key];
  return val !== undefined && val !== null ? String(val) : undefined;
}
