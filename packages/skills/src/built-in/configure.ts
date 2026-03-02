import fs from 'node:fs';
import path from 'node:path';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

// ── Supported services and their ENV keys ────────────────────────────────

interface ServiceField {
  env: string;
  label: string;
  required?: boolean;
  secret?: boolean;
}

const SERVICES: Record<string, { label: string; fields: ServiceField[] }> = {
  proxmox: {
    label: 'Proxmox VE',
    fields: [
      { env: 'ALFRED_PROXMOX_BASE_URL', label: 'Base URL (e.g. https://pve.local:8006)', required: true },
      { env: 'ALFRED_PROXMOX_TOKEN_ID', label: 'API Token ID (user@realm!name)', required: true },
      { env: 'ALFRED_PROXMOX_TOKEN_SECRET', label: 'API Token Secret', required: true, secret: true },
    ],
  },
  unifi: {
    label: 'UniFi Network',
    fields: [
      { env: 'ALFRED_UNIFI_BASE_URL', label: 'Base URL (e.g. https://unifi.local)', required: true },
      { env: 'ALFRED_UNIFI_API_KEY', label: 'API Key (preferred, UniFi OS)', secret: true },
      { env: 'ALFRED_UNIFI_USERNAME', label: 'Username (alternative to API key)' },
      { env: 'ALFRED_UNIFI_PASSWORD', label: 'Password (alternative to API key)', secret: true },
      { env: 'ALFRED_UNIFI_SITE', label: 'Site name (default: "default")' },
    ],
  },
};

// ── Skill ────────────────────────────────────────────────────────────────

export type ReloadCallback = (service: string) => Promise<{ success: boolean; error?: string }>;

export class ConfigureSkill extends Skill {
  private reloadCallback?: ReloadCallback;

  setReloadCallback(cb: ReloadCallback): void {
    this.reloadCallback = cb;
  }

  readonly metadata: SkillMetadata = {
    name: 'configure',
    description:
      'Configure Alfred services (Proxmox, UniFi, etc.) by writing environment variables. ' +
      'Use action "list_services" to see available services. ' +
      'Use action "show" to check current config of a service. ' +
      'Use action "set" to write config — provide service name and values. ' +
      'After setting config, the service is activated immediately — no restart needed.',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_services', 'show', 'set'],
          description: 'Action to perform',
        },
        service: {
          type: 'string',
          enum: ['proxmox', 'unifi'],
          description: 'Service to configure (required for show/set)',
        },
        values: {
          type: 'object',
          description: 'Key-value pairs to set. Keys are the ENV variable names (e.g. ALFRED_PROXMOX_BASE_URL). Only for action "set".',
        },
      },
      required: ['action'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'list_services':
        return this.listServices();
      case 'show':
        return this.showService(input.service as string);
      case 'set':
        return this.setService(input.service as string, input.values as Record<string, string> | undefined);
      default:
        return { success: false, error: `Unknown action "${action}". Use list_services, show, or set.` };
    }
  }

  private listServices(): SkillResult {
    const lines = ['| Service | Status | ENV Prefix |', '|---|---|---|'];
    for (const [key, svc] of Object.entries(SERVICES)) {
      const configured = svc.fields
        .filter(f => f.required)
        .every(f => !!process.env[f.env]);
      const status = configured ? 'configured' : 'not configured';
      const prefix = `ALFRED_${key.toUpperCase()}_*`;
      lines.push(`| ${svc.label} | ${status} | \`${prefix}\` |`);
    }
    return {
      success: true,
      data: Object.keys(SERVICES),
      display: lines.join('\n'),
    };
  }

  private showService(service: string): SkillResult {
    const svc = SERVICES[service];
    if (!svc) return { success: false, error: `Unknown service "${service}". Available: ${Object.keys(SERVICES).join(', ')}` };

    const lines = [`**${svc.label}** configuration:\n`];
    const data: Record<string, string | undefined> = {};
    for (const field of svc.fields) {
      const val = process.env[field.env];
      data[field.env] = val;
      const display = !val ? '_not set_' : (field.secret ? maskValue(val) : val);
      const req = field.required ? ' (required)' : '';
      lines.push(`- \`${field.env}\`: ${display}${req}`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async setService(service: string, values: Record<string, string> | undefined): Promise<SkillResult> {
    const svc = SERVICES[service];
    if (!svc) return { success: false, error: `Unknown service "${service}". Available: ${Object.keys(SERVICES).join(', ')}` };
    if (!values || Object.keys(values).length === 0) {
      return { success: false, error: `No values provided. Pass an object with ENV variable names as keys.\n\nAvailable keys for ${svc.label}:\n${svc.fields.map(f => `- \`${f.env}\`: ${f.label}${f.required ? ' (required)' : ''}`).join('\n')}` };
    }

    // Validate keys belong to this service
    const validKeys = new Set(svc.fields.map(f => f.env));
    for (const key of Object.keys(values)) {
      if (!validKeys.has(key)) {
        return { success: false, error: `Invalid key "${key}" for ${svc.label}. Valid keys: ${[...validKeys].join(', ')}` };
      }
    }

    // Find .env file — walk up from cwd
    const envPath = findEnvFile();
    if (!envPath) {
      return { success: false, error: 'Could not find .env file. Run `alfred setup` first or create a .env in your project root.' };
    }

    // Read, update, write
    let content = fs.readFileSync(envPath, 'utf-8');
    const written: string[] = [];

    for (const [key, value] of Object.entries(values)) {
      const escaped = value.replace(/\n/g, '\\n');
      const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
      if (pattern.test(content)) {
        content = content.replace(pattern, `${key}=${escaped}`);
      } else {
        content = content.trimEnd() + `\n${key}=${escaped}\n`;
      }
      written.push(key);
    }

    fs.writeFileSync(envPath, content, 'utf-8');

    // Check if all required fields are now set
    const missing = svc.fields
      .filter(f => f.required)
      .filter(f => !values[f.env] && !process.env[f.env])
      .map(f => `\`${f.env}\``);

    const lines = [
      `Written to \`${envPath}\`:\n`,
      ...written.map(k => `- \`${k}\` = ${svc.fields.find(f => f.env === k)?.secret ? maskValue(values[k]) : values[k]}`),
    ];

    if (missing.length > 0) {
      lines.push(`\n**Still missing:** ${missing.join(', ')}`);
    } else if (this.reloadCallback) {
      const result = await this.reloadCallback(service);
      if (result.success) {
        lines.push(`\n**${svc.label} wurde aktiviert.** Du kannst es jetzt sofort nutzen.`);
      } else {
        lines.push(`\n**${svc.label} is fully configured.** Hot-Reload fehlgeschlagen: ${result.error ?? 'unbekannter Fehler'}. Restart Alfred: \`alfred start\``);
      }
    } else {
      lines.push(`\n**${svc.label} is fully configured.** Restart Alfred to activate: \`alfred start\``);
    }

    return { success: true, data: { envPath, written }, display: lines.join('\n') };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function maskValue(val: string): string {
  if (val.length <= 4) return '****';
  return '*'.repeat(val.length - 4) + val.slice(-4);
}

function findEnvFile(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
