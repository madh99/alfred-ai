import type { SkillMetadata, SkillContext, SkillResult, CmdbAssetType, CmdbRelationType, CmdbLinkedEntityType } from '@alfred/types';
import type { CmdbRepository } from '@alfred/storage';
import { Skill } from '../skill.js';
import { NICHT_PRODUKTIV_UMGEBUNGEN, umgebungsVorschlag } from './cmdb-umgebung.js'; // Owner 22.11. K2/K3

type Action =
  | 'discover' | 'discover_source'
  | 'list_assets' | 'get_asset' | 'add_asset' | 'update_asset'
  | 'decommission_asset' | 'delete_asset'
  | 'add_relation' | 'remove_relation'
  | 'search' | 'topology' | 'stats'
  | 'asset_docs' | 'umgebung_offen' | 'umgebung_setzen';

interface DiscoveredAsset {
  name: string;
  assetType: CmdbAssetType;
  sourceSkill: string;
  sourceId: string;
  identifier?: string;
  ipAddress?: string;
  hostname?: string;
  fqdn?: string;
  /** Owner 22.11. K2 — Umgebung, wenn die Quelle sie kennt (Proxmox-Tags); undefined lässt den gepflegten Wert stehen */
  environment?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

interface DiscoveredRelation {
  sourceKey: string; // source_skill:source_id
  targetKey: string;
  relationType: CmdbRelationType;
}

/**
 * Owner 22.11. — lab/test/development nimmt ein Asset von der festen Gegenprüfung aus. Diese Werte setzt nur der Owner
 * (Web-CMDB schreibt direkt ins Repository, Proxmox-Tags über den Abgleich), nie der Skill — sonst könnte ein Modell sich
 * die Gegenprüfung selbst ersparen.
 */
function umgebungGesperrt(env: unknown): string | undefined {
  if (typeof env !== 'string' || !NICHT_PRODUKTIV_UMGEBUNGEN.has(env.trim().toLowerCase())) return undefined;
  return `Umgebung „${env}“ setzt nur der Owner (Web-CMDB oder Proxmox-Tag lab/test/dev) — sie nimmt das Asset von der Gegenprüfung durch ultra aus. Der Skill setzt nur production oder staging.`;
}

/** Typen, deren Umgebung für die Gegenprüfung zählt (Server, VMs, LXC) */
const UMGEBUNG_TYPEN = new Set(['vm', 'lxc', 'server']);

/** hosts: nur diese Hosts erfassen (Teil-Erfassung nach einem Change; nur Quellen, die das können — derzeit fernzugriff) */
export type DiscoverySource = (opt?: { hosts?: string[] }) => Promise<{ assets: DiscoveredAsset[]; relations: DiscoveredRelation[] }>;
/** Quellen, die eine Teil-Erfassung nach Hosts beherrschen */
const TEIL_ERFASSUNG = new Set(['fernzugriff']);

export class CmdbSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'cmdb',
    category: 'infrastructure',
    description:
      'Configuration Management Database — Zentrales Inventar aller Infrastruktur-Assets. ' +
      '"discover" scannt alle konfigurierten Infra-Skills und aktualisiert das CMDB. ' +
      '"discover_source" scannt nur eine bestimmte Quelle (source: proxmox/docker/unifi/cloudflare_dns/npm/pfsense/homeassistant/mikrotik). ' +
      '"list_assets" zeigt Assets (filter: asset_type, status, environment, source_skill, search, tags). ' +
      '"get_asset" zeigt Asset-Details + Relationen + Change-History (asset_id). ' +
      '"add_asset" erstellt ein Asset manuell (name, asset_type, ip_address, hostname, environment, owner, purpose, tags). ' +
      '"update_asset" aktualisiert ein Asset (asset_id + Felder). ' +
      '"decommission_asset" markiert ein Asset als stillgelegt (asset_id). ' +
      '"delete_asset" entfernt ein Asset aus der CMDB (asset_id). ' +
      '"add_relation" erstellt eine Beziehung (source_asset_id, target_asset_id, relation_type). ' +
      '"remove_relation" löscht eine Beziehung (relation_id). ' +
      '"search" sucht Assets per Freitext (query). ' +
      '"topology" zeigt den Beziehungsgraph eines Assets (asset_id, depth). ' +
      '"stats" zeigt CMDB-Statistiken. ' +
      '"asset_docs" zeigt verknuepfte Dokumente fuer ein Asset oder Service (asset_id oder service_id). ' +
      '"umgebung_offen" listet aktive Server/VMs/LXC ohne Umgebung mit Vorschlag (ohne Umgebung gelten sie für die Gegenprüfung als produktiv). ' +
      '"umgebung_setzen" setzt production oder staging für asset_ids — nur nach ausdrücklicher Bestätigung des Owners; lab/test/development setzt nur der Owner selbst (Web-CMDB, Proxmox-Tag).',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['discover', 'discover_source', 'list_assets', 'get_asset', 'add_asset', 'update_asset', 'decommission_asset', 'delete_asset', 'add_relation', 'remove_relation', 'search', 'topology', 'stats', 'asset_docs', 'umgebung_offen', 'umgebung_setzen'] },
        source: { type: 'string', description: 'Discovery-Quelle für discover_source' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'discover_source fernzugriff: nur diese Zugänge erfassen (Teil-Erfassung, markiert nichts als veraltet)' },
        asset_type: { type: 'string' },
        status: { type: 'string' },
        environment: { type: 'string' },
        source_skill: { type: 'string' },
        search: { type: 'string' },
        tags: { type: 'string' },
        asset_id: { type: 'string' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: 'umgebung_setzen: Asset-IDs (oder eindeutige ID-Präfixe ≥ 8)' },
        service_id: { type: 'string', description: 'Service-ID fuer asset_docs' },
        name: { type: 'string' },
        ip_address: { type: 'string' },
        hostname: { type: 'string' },
        fqdn: { type: 'string' },
        owner: { type: 'string' },
        purpose: { type: 'string' },
        notes: { type: 'string' },
        location: { type: 'string' },
        source_asset_id: { type: 'string' },
        target_asset_id: { type: 'string' },
        relation_type: { type: 'string' },
        relation_id: { type: 'string' },
        query: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['action'],
    },
    timeoutMs: 120_000,
  };

  private readonly repo: CmdbRepository;
  private readonly staleThresholdDays: number;
  private discoverySources: Map<string, DiscoverySource> = new Map();
  private kgSyncCallback?: (userId: string) => Promise<void>;
  private ipResolverCallback?: () => Promise<Array<{ mac: string; ip: string; hostname?: string; source: string }>>;

  constructor(repo: CmdbRepository, staleThresholdDays = 7) {
    super();
    this.repo = repo;
    this.staleThresholdDays = staleThresholdDays;
  }

  registerDiscoverySource(name: string, source: DiscoverySource): void {
    this.discoverySources.set(name, source);
  }

  setKgSyncCallback(cb: (userId: string) => Promise<void>): void {
    this.kgSyncCallback = cb;
  }

  /** Owner 22.11. K4 — nach jedem Abgleich (z. B. Befund „Umgebung fehlt“ fortschreiben) */
  private nachAbgleichCallback?: (userId: string) => Promise<void>;
  setNachAbgleichCallback(cb: (userId: string) => Promise<void>): void { this.nachAbgleichCallback = cb; }
  private async nachAbgleichMelden(userId: string): Promise<void> {
    try { await this.nachAbgleichCallback?.(userId); } catch { /* darf den Abgleich nie stören */ }
  }

  setIpResolverCallback(cb: () => Promise<Array<{ mac: string; ip: string; hostname?: string; source: string }>>): void {
    this.ipResolverCallback = cb;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId || context.userId;

    try {
      switch (action) {
        case 'discover': return await this.discover(userId);
        case 'discover_source': return await this.discoverSource(userId, input.source as string, Array.isArray(input.hosts) ? (input.hosts as unknown[]).map(String) : undefined);
        case 'list_assets': return await this.listAssets(userId, input);
        case 'get_asset': return await this.getAsset(userId, input.asset_id as string);
        case 'add_asset': return await this.addAsset(userId, input);
        case 'update_asset': return await this.updateAsset(userId, input);
        case 'decommission_asset': return await this.decommissionAsset(userId, input.asset_id as string);
        case 'delete_asset': return await this.deleteAsset(userId, input.asset_id as string);
        case 'add_relation': return await this.addRelation(userId, input);
        case 'remove_relation': return await this.removeRelation(userId, input.relation_id as string);
        case 'search': return await this.searchAssets(userId, input.query as string);
        case 'topology': return await this.getTopology(userId, input.asset_id as string, input.depth as number | undefined);
        case 'stats': return await this.getStats(userId);
        case 'asset_docs': return await this.assetDocs(userId, input);
        case 'umgebung_offen': return await this.umgebungOffen(userId);
        case 'umgebung_setzen': return await this.umgebungSetzen(userId, input);
        default: return { success: false, error: `Unbekannte Aktion: ${String(action)}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  // ── Discovery ──────────────────────────────────────────────

  private async discover(userId: string): Promise<SkillResult> {
    const runStart = new Date().toISOString();
    const results: string[] = [];
    let totalAssets = 0;
    let totalRelations = 0;

    for (const [name, source] of this.discoverySources) {
      try {
        const sourceResult = await source();
        const { assets, relations } = sourceResult;
        // v857 Fix D — Source kann optional failedCalls reporten damit der Result-
        // Text zwischen "wirklich 0 Assets" und "Skill-Calls failed → 0 Assets"
        // unterscheidet. Backwards-compat: wenn nicht gesetzt, weiterhin nur asset-count.
        const failedCalls = (sourceResult as { failedCalls?: number }).failedCalls;
        const failedReason = (sourceResult as { failedReason?: string }).failedReason;
        for (const a of assets) {
          await this.repo.upsertAsset(userId, {
            name: a.name,
            assetType: a.assetType,
            sourceSkill: a.sourceSkill,
            sourceId: a.sourceId,
            identifier: a.identifier,
            ipAddress: a.ipAddress,
            hostname: a.hostname,
            fqdn: a.fqdn,
            ...(a.environment ? { environment: a.environment as any } : {}), // Owner 22.11. K2 — vorher nie weitergereicht
            status: (a.status as any) ?? 'active',
            attributes: a.attributes ?? {},
          });
        }
        totalAssets += assets.length;

        // Auto-relations from this source
        // v857 Fix C — Defensive Guard: relations die nicht das erwartete
        // {sourceKey, targetKey, relationType}-Schema haben werden geskippt statt
        // den ganzen Source-Lauf zu crashen (war v857 Mikrotik-Bug: pushte
        // sourceEntityName/targetEntityName → split(undefined) → TypeError →
        // catch → "mikrotik: Fehler — Cannot read properties...").
        let droppedRelations = 0;
        for (const rel of relations) {
          if (
            !rel || typeof rel !== 'object' ||
            typeof rel.sourceKey !== 'string' || rel.sourceKey.length === 0 ||
            typeof rel.targetKey !== 'string' || rel.targetKey.length === 0 ||
            typeof rel.relationType !== 'string'
          ) {
            droppedRelations++;
            continue;
          }
          const srcAsset = await this.repo.getAssetBySource(userId, rel.sourceKey.split(':')[0], rel.sourceKey.split(':').slice(1).join(':'));
          const tgtAsset = await this.repo.getAssetBySource(userId, rel.targetKey.split(':')[0], rel.targetKey.split(':').slice(1).join(':'));
          if (srcAsset && tgtAsset) {
            await this.repo.upsertRelation(userId, srcAsset.id, tgtAsset.id, rel.relationType, true);
            totalRelations++;
          }
        }

        // Mark stale assets
        const stale = await this.repo.markStaleAssets(userId, name, runStart, this.staleThresholdDays);
        // v857 Fix C + D — Result-Line ergänzt um sichtbare droppedRelations + failedCalls
        // damit Schema-Drift bzw. Connectivity-Probleme nicht still bleiben.
        let line = `${name}: ${assets.length} Assets`;
        if (stale > 0) line += `, ${stale} stale`;
        if (droppedRelations > 0) line += ` (${droppedRelations} Relations skipped: malformed)`;
        if (assets.length === 0 && typeof failedCalls === 'number' && failedCalls > 0) {
          line += ` — ${failedCalls} Skill-Call${failedCalls === 1 ? '' : 's'} fehlgeschlagen${failedReason ? `: ${failedReason.slice(0, 80)}` : ''}`;
        }
        results.push(line);
      } catch (err: any) {
        results.push(`${name}: Fehler — ${err.message?.slice(0, 100)}`);
      }
    }

    // Cross-source IP resolution: fill missing IPs via ARP/DHCP MAC matching
    if (this.ipResolverCallback) {
      try {
        const macIpMap = await this.ipResolverCallback();
        const macToIp = new Map<string, string>();
        for (const entry of macIpMap) {
          if (entry.mac && entry.ip) macToIp.set(entry.mac.toLowerCase(), entry.ip);
        }
        // Find assets without IP that have a MAC in attributes
        const allAssets = await this.repo.listAssets(userId);
        let resolved = 0;
        for (const asset of allAssets) {
          if (asset.ipAddress) continue; // already has IP
          const mac = String(asset.attributes?.mac ?? '').toLowerCase();
          if (!mac) continue;
          const ip = macToIp.get(mac);
          if (ip) {
            await this.repo.updateAsset(userId, asset.id, { ipAddress: ip });
            resolved++;
          }
        }
        if (resolved > 0) results.push(`ip-resolution: ${resolved} IPs via MAC zugeordnet`);
      } catch { /* non-critical */ }
    }

    // Cross-source relation discovery
    try {
      const crossRels = await this.discoverCrossSourceRelations(userId);
      totalRelations += crossRels;
    } catch (err: any) {
      results.push(`cross-source: Fehler — ${err.message?.slice(0, 100)}`);
    }

    // KG sync
    if (this.kgSyncCallback) {
      try { await this.kgSyncCallback(userId); } catch { /* non-critical */ }
    }
    await this.nachAbgleichMelden(userId);

    const display = `## CMDB Discovery\n\n${results.map(r => `- ${r}`).join('\n')}\n\n**Gesamt:** ${totalAssets} Assets, ${totalRelations} Relationen`;
    return { success: true, data: { totalAssets, totalRelations, sources: results }, display };
  }

  private async discoverSource(userId: string, source: string, hosts?: string[]): Promise<SkillResult> {
    if (!source) return { success: false, error: 'source ist erforderlich' };
    const fn = this.discoverySources.get(source);
    if (!fn) return { success: false, error: `Unbekannte Quelle: ${source}. Verfügbar: ${[...this.discoverySources.keys()].join(', ')}` };
    // Realfall 19.11.2026: die volle Fernzugriff-Erfassung nach einem Change passte nie in die 120 s — Teil-Erfassung nur der berührten Hosts
    const teil = hosts !== undefined;
    if (teil && (!TEIL_ERFASSUNG.has(source) || hosts.length === 0)) return { success: false, error: `hosts gibt es nur für ${[...TEIL_ERFASSUNG].join(', ')} und nie leer` };

    const runStart = new Date().toISOString();
    const { assets, relations } = await fn(teil ? { hosts } : undefined);

    for (const a of assets) {
      await this.repo.upsertAsset(userId, {
        name: a.name, assetType: a.assetType, sourceSkill: a.sourceSkill, sourceId: a.sourceId,
        identifier: a.identifier, ipAddress: a.ipAddress, hostname: a.hostname, fqdn: a.fqdn,
        ...(a.environment ? { environment: a.environment as any } : {}), // Owner 22.11. K2
        status: (a.status as any) ?? 'active', attributes: a.attributes ?? {},
      });
    }

    let relCount = 0;
    for (const rel of relations) {
      try {
        const srcAsset = await this.repo.getAssetBySource(userId, rel.sourceKey.split(':')[0], rel.sourceKey.split(':').slice(1).join(':'));
        const tgtAsset = await this.repo.getAssetBySource(userId, rel.targetKey.split(':')[0], rel.targetKey.split(':').slice(1).join(':'));
        if (srcAsset && tgtAsset) {
          await this.repo.upsertRelation(userId, srcAsset.id, tgtAsset.id, rel.relationType, true);
          relCount++;
        }
      } catch { /* skip failed relation */ }
    }

    let stale = 0;
    // Teil-Erfassung: nie veraltet markieren — die nicht erfassten Hosts sind nicht verschwunden
    if (!teil) { try { stale = await this.repo.markStaleAssets(userId, source, runStart, this.staleThresholdDays); } catch { /* non-critical */ } }
    await this.nachAbgleichMelden(userId);
    const display = `## CMDB Discovery: ${source}${teil ? ` (nur ${hosts.join(', ')})` : ''}\n\n${assets.length} Assets, ${relCount} Relationen${stale > 0 ? `, ${stale} stale markiert` : ''}`;
    return { success: true, data: { assets: assets.length, relations: relCount, stale, ...(teil ? { hosts } : {}) }, display };
  }

  private async discoverCrossSourceRelations(userId: string): Promise<number> {
    const allAssets = await this.repo.listAssets(userId);
    const byIp = new Map<string, typeof allAssets>();
    for (const a of allAssets) {
      if (!a.ipAddress) continue;
      const list = byIp.get(a.ipAddress) || [];
      list.push(a);
      byIp.set(a.ipAddress, list);
    }

    let count = 0;

    for (const a of allAssets) {
      // DNS resolves_to: DNS record content matches an asset IP
      if (a.assetType === 'dns_record' && a.attributes?.content) {
        const targetIp = a.attributes.content as string;
        const targets = byIp.get(targetIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && !['dns_record', 'firewall_rule'].includes(t.assetType)) {
              await this.repo.upsertRelation(userId, a.id, t.id, 'resolves_to', true);
              count++;
            }
          }
        }
      }

      // Proxy routes_to: forward_host matches an asset IP
      if (a.assetType === 'proxy_host' && a.attributes?.forward_host) {
        const targetIp = a.attributes.forward_host as string;
        const targets = byIp.get(targetIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && !['dns_record', 'proxy_host', 'firewall_rule'].includes(t.assetType)) {
              await this.repo.upsertRelation(userId, a.id, t.id, 'routes_to', true);
              count++;
            }
          }
        }
      }

      // Container runs_on: container host IP matches a VM/LXC
      if (a.assetType === 'container' && a.attributes?.host_ip) {
        const hostIp = a.attributes.host_ip as string;
        const hosts = byIp.get(hostIp);
        if (hosts) {
          for (const h of hosts) {
            if (['vm', 'lxc', 'server'].includes(h.assetType)) {
              await this.repo.upsertRelation(userId, a.id, h.id, 'runs_on', true);
              count++;
            }
          }
        }
      }

      // Firewall protects: rule destination matches an asset IP
      if (a.assetType === 'firewall_rule' && a.attributes?.destination_address) {
        const destIp = a.attributes.destination_address as string;
        const targets = byIp.get(destIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && t.assetType !== 'firewall_rule') {
              await this.repo.upsertRelation(userId, a.id, t.id, 'protects', true);
              count++;
            }
          }
        }
      }
    }

    return count;
  }

  // ── CRUD ───────────────────────────────────────────────────

  private async listAssets(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const assets = await this.repo.listAssets(userId, {
      assetType: input.asset_type as any, status: input.status as any,
      environment: input.environment as any, sourceSkill: input.source_skill as string,
      search: input.search as string, tags: input.tags as string,
    });

    if (assets.length === 0) return { success: true, data: [], display: 'Keine Assets gefunden.' };

    const lines = assets.map(a => {
      const status = a.status === 'active' ? '🟢' : a.status === 'degraded' ? '🟡' : a.status === 'decommissioned' ? '⚫' : a.status === 'unknown' ? '❓' : '🔴';
      return `| ${a.name} | ${a.assetType} | ${a.ipAddress ?? '—'} | ${status} ${a.status} | ${a.sourceSkill ?? 'manual'} | ${a.environment ?? '—'} |`;
    });

    const display = `## CMDB Assets (${assets.length})\n\n| Name | Typ | IP | Status | Quelle | Env |\n|------|-----|----|----|--------|-----|\n${lines.join('\n')}`;
    return { success: true, data: assets, display };
  }

  private async getAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const asset = await this.repo.getAssetById(userId, assetId);
    if (!asset) return { success: false, error: `Asset ${assetId} nicht gefunden` };

    const relations = await this.repo.getRelationsForAsset(userId, assetId);
    const changes = await this.repo.getChangesForAsset(userId, assetId, 10);

    const relLines = relations.map(r => {
      const dir = r.sourceAssetId === assetId ? '→' : '←';
      const otherId = r.sourceAssetId === assetId ? r.targetAssetId : r.sourceAssetId;
      return `- ${r.relationType} ${dir} ${otherId}${r.autoDiscovered ? ' (auto)' : ''}`;
    });

    const changeLines = changes.slice(0, 10).map(c =>
      `- ${c.createdAt?.slice(0, 16)} ${c.changeType}${c.fieldName ? `: ${c.fieldName}` : ''}${c.description ? ` — ${c.description}` : ''}`,
    );

    const display = [
      `## ${asset.name}`,
      `**Typ:** ${asset.assetType} | **Status:** ${asset.status} | **Env:** ${asset.environment ?? '—'}`,
      asset.ipAddress ? `**IP:** ${asset.ipAddress}` : '',
      asset.hostname ? `**Hostname:** ${asset.hostname}` : '',
      asset.fqdn ? `**FQDN:** ${asset.fqdn}` : '',
      asset.owner ? `**Owner:** ${asset.owner}` : '',
      asset.purpose ? `**Zweck:** ${asset.purpose}` : '',
      asset.tags ? `**Tags:** ${asset.tags}` : '',
      asset.notes ? `**Notizen:** ${asset.notes}` : '',
      asset.sourceSkill ? `**Quelle:** ${asset.sourceSkill}:${asset.sourceId}` : '',
      '',
      relLines.length > 0 ? `### Relationen\n${relLines.join('\n')}` : '',
      changeLines.length > 0 ? `### Letzte Änderungen\n${changeLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: { asset, relations, changes }, display };
  }

  private async addAsset(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.name as string;
    const assetType = input.asset_type as CmdbAssetType;
    if (!name || !assetType) return { success: false, error: 'name und asset_type erforderlich' };
    const sperre = umgebungGesperrt(input.environment);
    if (sperre) return { success: false, error: sperre };

    const asset = await this.repo.upsertAsset(userId, {
      name, assetType,
      ipAddress: input.ip_address as string,
      hostname: input.hostname as string,
      fqdn: input.fqdn as string,
      environment: input.environment as any,
      owner: input.owner as string,
      purpose: input.purpose as string,
      tags: input.tags as string,
      notes: input.notes as string,
      location: input.location as string,
    });

    await this.repo.logChange(userId, asset.id, 'created', 'manual', undefined, undefined, undefined, `Asset ${name} erstellt`);
    return { success: true, data: asset, display: `✅ Asset erstellt: ${name} (${assetType}) — ID: ${asset.id}` };
  }

  private async updateAsset(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const assetId = input.asset_id as string;
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const sperre = umgebungGesperrt(input.environment);
    if (sperre) return { success: false, error: sperre };

    const updates: Record<string, unknown> = {};
    for (const key of ['name', 'status', 'environment', 'ip_address', 'hostname', 'fqdn', 'owner', 'purpose', 'tags', 'notes', 'location']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.asset_type) updates.assetType = input.asset_type;

    const result = await this.repo.updateAsset(userId, assetId, updates as any);
    if (!result) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, data: result, display: `✅ Asset ${result.name} aktualisiert` };
  }

  /** Owner 22.11. K3 — aktive Server/VMs/LXC ohne Umgebung, je mit Vorschlag aus festen Namensregeln (nie automatisch gesetzt). */
  async umgebungOffen(userId: string): Promise<SkillResult> {
    const offen = (await this.repo.listAssets(userId)).filter(a => UMGEBUNG_TYPEN.has(a.assetType) && a.status === 'active' && !a.environment)
      .map(a => ({ id: a.id, name: a.name, typ: a.assetType, quelle: a.sourceSkill ?? 'manuell', vorschlag: umgebungsVorschlag(a.name) }))
      .sort((x, y) => x.vorschlag.localeCompare(y.vorschlag) || x.name.localeCompare(y.name));
    if (!offen.length) return { success: true, data: [], display: 'Alle aktiven Server, VMs und LXC haben eine Umgebung.' };
    const nichtProd = offen.filter(o => NICHT_PRODUKTIV_UMGEBUNGEN.has(o.vorschlag));
    const zeilen = offen.map(o => `| ${o.name} | ${o.typ} | ${o.quelle} | ${o.vorschlag} |`);
    return {
      success: true, data: offen,
      display: [`${offen.length} aktive Server/VMs/LXC ohne Umgebung (gelten für die Gegenprüfung als produktiv):`, '', '| Name | Typ | Quelle | Vorschlag |', '|---|---|---|---|', ...zeilen, '',
        `production/staging setzt umgebung_setzen nach Bestätigung durch den Owner. ${nichtProd.length ? `lab/test/development (${nichtProd.length} Vorschläge) setzt nur der Owner: Web-CMDB oder Proxmox-Tag lab/test/dev.` : ''}`].join('\n'),
    };
  }

  /** Owner 22.11. K3 — Umgebung production/staging für mehrere Assets (IDs oder ID-Präfix ≥ 8); lab/test/development nie. */
  async umgebungSetzen(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const env = String(input.environment ?? '').trim().toLowerCase();
    const sperre = umgebungGesperrt(env);
    if (sperre) return { success: false, error: sperre };
    if (env !== 'production' && env !== 'staging') return { success: false, error: 'environment: production oder staging' };
    const ids = Array.isArray(input.asset_ids) ? (input.asset_ids as unknown[]).map(String).filter(Boolean) : [];
    if (!ids.length) return { success: false, error: 'asset_ids erforderlich (Liste)' };
    const alle = await this.repo.listAssets(userId);
    const gesetzt: string[] = []; const fehler: string[] = [];
    for (const id of ids) {
      const treffer = alle.filter(a => a.id === id || (id.length >= 8 && a.id.startsWith(id)));
      if (treffer.length !== 1) { fehler.push(`${id}: ${treffer.length ? 'mehrdeutig' : 'nicht gefunden'}`); continue; }
      const a = treffer[0]!;
      await this.repo.updateAsset(userId, a.id, { environment: env as any });
      gesetzt.push(a.name);
    }
    return { success: fehler.length === 0, data: { gesetzt, fehler }, display: `Umgebung ${env} gesetzt: ${gesetzt.length}${gesetzt.length ? ` (${gesetzt.slice(0, 20).join(', ')}${gesetzt.length > 20 ? ' …' : ''})` : ''}${fehler.length ? `\nNicht gesetzt: ${fehler.join('; ')}` : ''}`, ...(fehler.length ? { error: fehler.join('; ') } : {}) };
  }

  private async decommissionAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const ok = await this.repo.decommissionAsset(userId, assetId);
    if (!ok) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, display: `✅ Asset ${assetId} dekommissioniert` };
  }

  private async deleteAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const ok = await this.repo.deleteAsset(userId, assetId);
    if (!ok) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, display: `✅ Asset ${assetId} gelöscht` };
  }

  private async addRelation(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const src = input.source_asset_id as string;
    const tgt = input.target_asset_id as string;
    const type = input.relation_type as CmdbRelationType;
    if (!src || !tgt || !type) return { success: false, error: 'source_asset_id, target_asset_id und relation_type erforderlich' };

    const rel = await this.repo.upsertRelation(userId, src, tgt, type);
    return { success: true, data: rel, display: `✅ Relation erstellt: ${src} — ${type} → ${tgt}` };
  }

  private async removeRelation(userId: string, relationId: string): Promise<SkillResult> {
    if (!relationId) return { success: false, error: 'relation_id erforderlich' };
    const ok = await this.repo.removeRelation(userId, relationId);
    if (!ok) return { success: false, error: `Relation ${relationId} nicht gefunden` };
    return { success: true, display: `✅ Relation ${relationId} gelöscht` };
  }

  private async searchAssets(userId: string, query: string): Promise<SkillResult> {
    if (!query) return { success: false, error: 'query erforderlich' };
    const assets = await this.repo.searchAssets(userId, query);
    if (assets.length === 0) return { success: true, data: [], display: `Keine Assets für "${query}" gefunden.` };

    const lines = assets.map(a => `- **${a.name}** (${a.assetType}) — ${a.ipAddress ?? '—'} — ${a.status}`);
    return { success: true, data: assets, display: `## Suche: "${query}"\n\n${lines.join('\n')}` };
  }

  private async getTopology(userId: string, assetId: string, depth?: number): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const topo = await this.repo.getTopology(userId, assetId, depth ?? 3);

    const lines = topo.assets.map(a => `- ${a.name} (${a.assetType}) [${a.status}]`);
    const relLines = topo.relations.map(r => `- ${r.sourceAssetId} —${r.relationType}→ ${r.targetAssetId}`);

    const display = `## Topologie (${topo.assets.length} Assets, ${topo.relations.length} Relationen)\n\n### Assets\n${lines.join('\n')}\n\n### Relationen\n${relLines.join('\n')}`;
    return { success: true, data: topo, display };
  }

  private async getStats(userId: string): Promise<SkillResult> {
    const stats = await this.repo.getStats(userId);

    const typeLines = Object.entries(stats.byType).map(([k, v]) => `| ${k} | ${v} |`);
    const statusLines = Object.entries(stats.byStatus).map(([k, v]) => `| ${k} | ${v} |`);
    const sourceLines = Object.entries(stats.bySource).map(([k, v]) => `| ${k} | ${v} |`);

    const display = [
      `## CMDB Statistik — ${stats.total} Assets`,
      '',
      '### Nach Typ',
      '| Typ | Anzahl |', '|-----|--------|',
      ...typeLines,
      '',
      '### Nach Status',
      '| Status | Anzahl |', '|--------|--------|',
      ...statusLines,
      '',
      '### Nach Quelle',
      '| Quelle | Anzahl |', '|--------|--------|',
      ...sourceLines,
    ].join('\n');

    return { success: true, data: stats, display };
  }

  private async assetDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const entityId = (input.asset_id ?? input.service_id) as string;
    const entityType: CmdbLinkedEntityType = input.service_id ? 'service' : 'asset';
    if (!entityId) return { success: false, error: 'asset_id oder service_id erforderlich' };
    const docs = await this.repo.getDocumentsForEntity(userId, entityType, entityId);
    if (docs.length === 0) return { success: true, data: { docs: [] }, display: 'Keine Dokumente fuer dieses Asset/Service.' };
    const lines = docs.map(d => `- **${d.title}** [${d.docType}] v${d.version} (${d.createdAt?.slice(0, 10) ?? '—'})`);
    return { success: true, data: { docs, count: docs.length }, display: `## Dokumente (${docs.length})\n${lines.join('\n')}` };
  }
}
