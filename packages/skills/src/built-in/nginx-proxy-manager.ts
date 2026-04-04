import type { SkillMetadata, SkillContext, SkillResult, NginxProxyManagerConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'list_hosts' | 'create_host' | 'update_host' | 'delete_host' | 'list_certificates';

export class NginxProxyManagerSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'nginx_proxy_manager',
    category: 'infrastructure',
    description:
      'Nginx Proxy Manager — Reverse-Proxy-Verwaltung mit automatischem SSL. ' +
      '"list_hosts" zeigt alle Proxy-Hosts. ' +
      '"create_host" erstellt einen neuen Proxy-Host (domain, target_host, target_port). SSL via Let\'s Encrypt automatisch. ' +
      '"update_host" aktualisiert einen Host (host_id). ' +
      '"delete_host" löscht einen Host (host_id). ' +
      '"list_certificates" zeigt SSL-Zertifikate.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_hosts', 'create_host', 'update_host', 'delete_host', 'list_certificates'] },
        domain: { type: 'string', description: 'Domain für den Proxy-Host (z.B. uboot.cc)' },
        target_host: { type: 'string', description: 'Ziel-IP oder Hostname (z.B. 192.168.1.95)' },
        target_port: { type: 'number', description: 'Ziel-Port (z.B. 3000)' },
        ssl: { type: 'boolean', description: 'SSL via Let\'s Encrypt aktivieren (default: true)' },
        force_ssl: { type: 'boolean', description: 'HTTP → HTTPS Redirect erzwingen (default: true)' },
        host_id: { type: 'number', description: 'Host-ID für update/delete' },
        forward_scheme: { type: 'string', description: 'http oder https (default: http)' },
        additional_domains: { type: 'array', description: 'Weitere Domains für denselben Host' },
      },
      required: ['action'],
    },
  };

  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(config: NginxProxyManagerConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.email = config.email;
    this.password = config.password;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    switch (action) {
      case 'list_hosts': return this.listHosts();
      case 'create_host': return this.createHost(input);
      case 'update_host': return this.updateHost(input);
      case 'delete_host': return this.deleteHost(input);
      case 'list_certificates': return this.listCertificates();
      default: return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }

  /** Authenticate and get JWT token (auto-refresh). */
  private async ensureAuth(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const res = await fetch(`${this.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: this.email, secret: this.password }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`NPM Auth fehlgeschlagen: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json() as { token: string; expires?: string };
    this.token = data.token;
    const expiresMs = data.expires ? new Date(data.expires).getTime() : Date.now() + 3_600_000;
    this.tokenExpiresAt = (isNaN(expiresMs) ? Date.now() + 3_600_000 : expiresMs) - 60_000;
    return this.token;
  }

  private async npmFetch(path: string, options?: RequestInit): Promise<any> {
    const token = await this.ensureAuth();
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`NPM API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  private async listHosts(): Promise<SkillResult> {
    const hosts = await this.npmFetch('/nginx/proxy-hosts') as Array<{
      id: number; domain_names: string[]; forward_host: string; forward_port: number;
      forward_scheme: string; ssl_forced: number; enabled: number;
      meta?: { letsencrypt_email?: string };
    }>;

    const lines = hosts.map(h => {
      const domains = h.domain_names.join(', ');
      const ssl = h.ssl_forced ? '🔒' : '⬜';
      const status = h.enabled ? '🟢' : '🔴';
      return `| ${h.id} | ${domains} | ${h.forward_scheme}://${h.forward_host}:${h.forward_port} | ${ssl} | ${status} |`;
    });

    const display = `## Nginx Proxy Manager — Hosts\n\n| ID | Domains | Target | SSL | Status |\n|----|---------|--------|-----|--------|\n${lines.join('\n')}`;
    return { success: true, data: hosts, display };
  }

  private async createHost(input: Record<string, unknown>): Promise<SkillResult> {
    const domain = input.domain as string;
    const targetHost = input.target_host as string;
    const targetPort = input.target_port as number;
    if (!domain || !targetHost || !targetPort) {
      return { success: false, error: 'domain, target_host und target_port erforderlich' };
    }

    const domains = [domain, ...((input.additional_domains as string[]) ?? [])];
    const ssl = input.ssl !== false;
    const forceSsl = input.force_ssl !== false;
    const scheme = (input.forward_scheme as string) ?? 'http';

    const body: Record<string, unknown> = {
      domain_names: domains,
      forward_scheme: scheme,
      forward_host: targetHost,
      forward_port: targetPort,
      access_list_id: 0,
      certificate_id: 0,
      ssl_forced: forceSsl ? 1 : 0,
      http2_support: 1,
      block_exploits: 1,
      allow_websocket_upgrade: 1,
      meta: {
        letsencrypt_agree: true,
        dns_challenge: false,
      },
      advanced_config: '',
      locations: [],
    };

    // If SSL requested, create with Let's Encrypt
    if (ssl) {
      body.certificate_id = 'new';
      body.meta = {
        letsencrypt_email: this.email,
        letsencrypt_agree: true,
        dns_challenge: false,
      };
    }

    const result = await this.npmFetch('/nginx/proxy-hosts', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { id: number; domain_names: string[] };

    return {
      success: true,
      data: result,
      display: `✅ Proxy Host erstellt: ${domains.join(', ')} → ${scheme}://${targetHost}:${targetPort}${ssl ? ' (SSL auto)' : ''} — ID: ${result.id}`,
    };
  }

  private async updateHost(input: Record<string, unknown>): Promise<SkillResult> {
    const hostId = input.host_id as number;
    if (!hostId) return { success: false, error: 'host_id erforderlich' };

    // Fetch current config first
    const current = await this.npmFetch(`/nginx/proxy-hosts/${hostId}`) as Record<string, unknown>;

    // Merge updates
    const body: Record<string, unknown> = { ...current };
    if (input.domain) body.domain_names = [input.domain, ...((input.additional_domains as string[]) ?? [])];
    if (input.target_host) body.forward_host = input.target_host;
    if (input.target_port) body.forward_port = input.target_port;
    if (input.forward_scheme) body.forward_scheme = input.forward_scheme;
    if (input.force_ssl !== undefined) body.ssl_forced = input.force_ssl ? 1 : 0;

    // Remove read-only fields
    for (const key of ['id', 'created_on', 'modified_on', 'owner_user_id', 'certificate']) {
      delete body[key];
    }

    const result = await this.npmFetch(`/nginx/proxy-hosts/${hostId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return { success: true, data: result, display: `✅ Proxy Host ${hostId} aktualisiert` };
  }

  private async deleteHost(input: Record<string, unknown>): Promise<SkillResult> {
    const hostId = input.host_id as number;
    if (!hostId) return { success: false, error: 'host_id erforderlich' };

    await this.npmFetch(`/nginx/proxy-hosts/${hostId}`, { method: 'DELETE' });
    return { success: true, display: `✅ Proxy Host ${hostId} gelöscht` };
  }

  private async listCertificates(): Promise<SkillResult> {
    const certs = await this.npmFetch('/nginx/certificates') as Array<{
      id: number; nice_name: string; domain_names: string[]; expires_on: string; provider: string;
    }>;

    const lines = certs.map(c => {
      const domains = c.domain_names.join(', ');
      const expires = c.expires_on ? new Date(c.expires_on).toLocaleDateString('de-AT') : '?';
      return `| ${c.id} | ${domains} | ${c.provider} | ${expires} |`;
    });

    const display = `## SSL-Zertifikate\n\n| ID | Domains | Provider | Ablauf |\n|----|---------|----------|--------|\n${lines.join('\n')}`;
    return { success: true, data: certs, display };
  }
}
