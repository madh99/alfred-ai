/**
 * Commvault Storage Module — 12 actions for storage pool management
 *
 * V4 API response field mapping (from OpenAPI3.yaml):
 *   GET /V4/Storage/Disk       → { diskStorage: StorageListSummary[] }
 *   GET /V4/Storage/Cloud      → { cloudStorage: StorageListSummary[] }
 *   GET /V4/Storage/Local      → { diskStorage: StorageListSummary[] }   (same schema as disk)
 *   GET /V4/Storage/HyperScale → { hyperScaleStorage: StorageListSummary[] }
 *   GET /V4/Storage/Tape       → { tapeStorage: TapeSummary[] }
 *   GET /V4/StorageArrays      → { arrays: ArrayLevel[] }
 *   GET /V4/MountPath/Content  → { mountpathName, totalSizeOnMedia, totalDataWritten, jobInfoList }
 *
 * StorageListSummary: { id, name, storagePoolType, status, capacity (MB), freeSpace (MB), storageType }
 * TapeSummary:        { id, name, storageType }
 * ArrayLevel:         { id, name, userName, vendor }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { formatSize, usagePct, requireId, optionalString } from './types.js';

// ── Helper: extract settled values, ignoring rejected ───────
function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

export class CommvaultStorage {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Alle Storage Pools (Disk + Cloud + Local + HyperScale) ──

  async list(): Promise<SkillResult> {
    const [disk, cloud, local, hyperscale] = await Promise.allSettled([
      this.api.get<any>('/V4/Storage/Disk'),
      this.api.get<any>('/V4/Storage/Cloud'),
      this.api.get<any>('/V4/Storage/Local'),
      this.api.get<any>('/V4/Storage/HyperScale'),
    ]);

    const diskPools = (settled(disk)?.diskStorage ?? []).map((p: any) => ({ ...p, _type: 'Disk' }));
    const cloudPools = (settled(cloud)?.cloudStorage ?? []).map((p: any) => ({ ...p, _type: 'Cloud' }));
    const localPools = (settled(local)?.diskStorage ?? []).map((p: any) => ({ ...p, _type: 'Local' }));
    const hsPools = (settled(hyperscale)?.hyperScaleStorage ?? []).map((p: any) => ({ ...p, _type: 'HyperScale' }));

    const all = [...diskPools, ...cloudPools, ...localPools, ...hsPools];

    const lines = ['## Commvault Storage Pools', `${all.length} Pools gefunden`, ''];
    for (const p of all) {
      const cap = p.capacity ?? 0;
      const free = p.freeSpace ?? 0;
      const pct = usagePct(cap, free);
      const warn = pct >= 85 ? ' !! WARNUNG' : '';
      lines.push(
        `**${p.name ?? '?'}** [${p._type}] (ID: ${p.id ?? '?'})${p.status ? ` [${p.status}]` : ''}${warn}`,
      );
      if (cap > 0) {
        lines.push(`  ${pct}% belegt | ${formatSize(free)} frei von ${formatSize(cap)}`);
      }
      if (p.storagePoolType) lines.push(`  Typ: ${p.storagePoolType}`);
    }

    return {
      success: true,
      data: { total: all.length, disk: diskPools.length, cloud: cloudPools.length, local: localPools.length, hyperscale: hsPools.length },
      display: lines.join('\n'),
    };
  }

  // ── 2. detail — Storage Pool Details ──

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'pool_id');
    const storageType = optionalString(input, 'storage_type') ?? 'Disk';
    const typePath = this.resolveTypePath(storageType);

    const data = await this.api.get<any>(`/V4/Storage/${typePath}/${id}`);

    const lines = [`## Storage Pool Detail (ID: ${id})`, ''];
    const name = data.name ?? data.storagePoolName ?? '?';
    lines.push(`**Name:** ${name}`);
    if (data.status) lines.push(`**Status:** ${data.status}`);
    if (data.storagePoolType) lines.push(`**Pool-Typ:** ${data.storagePoolType}`);
    if (data.capacity !== undefined) {
      const cap = data.capacity ?? 0;
      const free = data.freeSpace ?? 0;
      lines.push(`**Kapazitat:** ${formatSize(cap)} (${formatSize(free)} frei, ${usagePct(cap, free)}% belegt)`);
    }

    // Backup locations
    const locations = data.backupLocations ?? data.mountPathList ?? [];
    if (locations.length > 0) {
      lines.push('', '**Backup Locations:**');
      for (const loc of locations) {
        const locName = loc.backupLocation?.name ?? loc.mountPathName ?? loc.name ?? '?';
        const locId = loc.backupLocation?.id ?? loc.id ?? '';
        const ma = loc.mediaAgent?.name ?? loc.mediaAgentName ?? '';
        lines.push(`  - ${locName}${locId ? ` (ID: ${locId})` : ''}${ma ? ` — MA: ${ma}` : ''}`);
      }
    }

    // Associated copies / plans
    const copies = data.associatedCopies ?? [];
    if (copies.length > 0) {
      lines.push('', '**Assoziierte Copies:**');
      for (const c of copies) {
        lines.push(`  - ${c.copyName ?? c.name ?? '?'} (Plan: ${c.plan?.name ?? '?'})`);
      }
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── 3. createDisk — Disk Pool erstellen (HIGH_RISK) ──

  async createDisk(input: Record<string, unknown>): Promise<SkillResult> {
    const name = optionalString(input, 'name');
    if (!name) return { success: false, error: 'Parameter "name" ist erforderlich' };

    const body: Record<string, unknown> = { name };
    if (input.deduplication !== undefined) body.enableDeduplication = input.deduplication;
    if (input.path || input.mediaAgent) {
      const mp: Record<string, unknown> = {};
      if (input.path) mp.path = input.path;
      if (input.mediaAgent) mp.mediaAgent = { name: input.mediaAgent };
      body.mountPathList = [mp];
    }

    const result = await this.api.post<any>('/V4/Storage/Disk', body);
    return {
      success: true,
      data: result,
      display: `Disk Storage Pool "${name}" erstellt (ID: ${result.id ?? result.storagePoolId ?? '?'}).`,
    };
  }

  // ── 4. createCloud — Cloud Pool erstellen (HIGH_RISK) ──

  async createCloud(input: Record<string, unknown>): Promise<SkillResult> {
    const name = optionalString(input, 'name');
    if (!name) return { success: false, error: 'Parameter "name" ist erforderlich' };

    const body: Record<string, unknown> = { name };
    if (input.cloudType) body.cloudType = input.cloudType;
    if (input.serviceHost) body.serviceHost = input.serviceHost;
    if (input.container) body.container = input.container;
    if (input.credentials) body.credentials = input.credentials;
    if (input.mediaAgent) body.mediaAgent = { name: input.mediaAgent };

    const result = await this.api.post<any>('/V4/Storage/Cloud', body);
    return {
      success: true,
      data: result,
      display: `Cloud Storage Pool "${name}" erstellt (ID: ${result.id ?? result.cloudStorageId ?? '?'}).`,
    };
  }

  // ── 5. createLocal — Local Pool erstellen (HIGH_RISK) ──

  async createLocal(input: Record<string, unknown>): Promise<SkillResult> {
    const name = optionalString(input, 'name');
    if (!name) return { success: false, error: 'Parameter "name" ist erforderlich' };

    const body: Record<string, unknown> = { name };
    if (input.path || input.mediaAgent) {
      const mp: Record<string, unknown> = {};
      if (input.path) mp.path = input.path;
      if (input.mediaAgent) mp.mediaAgent = { name: input.mediaAgent };
      body.mountPathList = [mp];
    }

    const result = await this.api.post<any>('/V4/Storage/Local', body);
    return {
      success: true,
      data: result,
      display: `Local Storage Pool "${name}" erstellt (ID: ${result.id ?? result.storagePoolId ?? '?'}).`,
    };
  }

  // ── 6. delete — Storage Pool loschen (HIGH_RISK) ──

  async delete(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'pool_id');
    const storageType = optionalString(input, 'storage_type') ?? 'Disk';
    const typePath = this.resolveTypePath(storageType);

    const result = await this.api.delete<any>(`/V4/Storage/${typePath}/${id}`);
    return {
      success: true,
      data: result,
      display: `Storage Pool ${id} (${storageType}) geloscht.`,
    };
  }

  // ── 7. tape — Tape Libraries auflisten ──

  async tape(_input: Record<string, unknown>): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/Storage/Tape');
    const tapes = data.tapeStorage ?? [];

    const lines = ['## Tape Libraries', `${tapes.length} Libraries`, ''];
    for (const t of tapes) {
      lines.push(`**${t.name ?? '?'}** (ID: ${t.id ?? '?'}) — Typ: ${t.storageType ?? '?'}`);
    }

    return { success: true, data: { total: tapes.length, tapes }, display: lines.join('\n') };
  }

  // ── 8. tapeDetail — Tape Library Detail + Media + Drives ──

  async tapeDetail(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'library_id');

    const [detail, media, drives] = await Promise.allSettled([
      this.api.get<any>(`/V4/Storage/Tape/${id}`),
      this.api.get<any>(`/V4/Storage/Tape/${id}/Media`),
      this.api.get<any>(`/V4/Storage/Tape/${id}/Drive`),
    ]);

    const detailData = settled(detail) ?? {};
    const mediaList = settled(media)?.media ?? settled(media)?.tapeMedia ?? [];
    const driveList = settled(drives)?.drives ?? settled(drives)?.tapeDrives ?? [];

    const lines = [`## Tape Library (ID: ${id})`, ''];
    lines.push(`**Name:** ${detailData.name ?? '?'}`);
    if (detailData.storageType) lines.push(`**Typ:** ${detailData.storageType}`);

    if (mediaList.length > 0) {
      lines.push('', `**Media:** ${mediaList.length} Medien`);
      for (const m of mediaList.slice(0, 20)) {
        const label = m.barcode ?? m.label ?? m.name ?? '?';
        const status = m.status ?? '';
        lines.push(`  - ${label}${status ? ` [${status}]` : ''}`);
      }
      if (mediaList.length > 20) lines.push(`  ... und ${mediaList.length - 20} weitere`);
    }

    if (driveList.length > 0) {
      lines.push('', `**Drives:** ${driveList.length}`);
      for (const d of driveList) {
        lines.push(`  - ${d.name ?? d.alias ?? '?'} (ID: ${d.id ?? '?'})${d.status ? ` [${d.status}]` : ''}`);
      }
    }

    return { success: true, data: { detail: detailData, media: mediaList, drives: driveList }, display: lines.join('\n') };
  }

  // ── 9. ddb — Dedup-DB Media Agents ──

  async ddb(): Promise<SkillResult> {
    // The V4 API has /V4/DDB/MediaAgents for listing DDB-capable media agents
    // and /V4/StoragePool/DDB (PUT only) for updating DDB properties.
    // We list DDB media agents as the closest "list" operation.
    const data = await this.api.get<any>('/V4/DDB/MediaAgents');
    const agents = data.mediaAgentList ?? data.mediaAgents ?? [];

    const lines = ['## DDB Media Agents', `${agents.length} Agents`, ''];
    for (const a of agents) {
      const name = a.mediaAgent?.name ?? a.name ?? '?';
      const id = a.mediaAgent?.id ?? a.id ?? '';
      lines.push(`- **${name}**${id ? ` (ID: ${id})` : ''}`);
    }

    return { success: true, data: { total: agents.length, agents }, display: lines.join('\n') };
  }

  // ── 10. arrays — Storage Arrays auflisten ──

  async arrays(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/StorageArrays');
    const arrays = data.arrays ?? [];

    const lines = ['## Storage Arrays', `${arrays.length} Arrays`, ''];
    for (const a of arrays) {
      lines.push(`**${a.name ?? '?'}** (ID: ${a.id ?? '?'})${a.vendor ? ` — Vendor: ${a.vendor}` : ''}${a.userName ? ` (User: ${a.userName})` : ''}`);
    }

    return { success: true, data: { total: arrays.length, arrays }, display: lines.join('\n') };
  }

  // ── 11. backupLocations — Backup Locations eines Pools ──

  async backupLocations(input: Record<string, unknown>): Promise<SkillResult> {
    const poolId = requireId(input, 'pool_id');
    const locationId = requireId(input, 'location_id');
    const storageType = optionalString(input, 'storage_type') ?? 'Disk';
    const typePath = this.resolveTypePath(storageType);

    const data = await this.api.get<any>(`/V4/Storage/${typePath}/${poolId}/BackupLocation/${locationId}`);

    const lines = [`## Backup Location (Pool: ${poolId}, Location: ${locationId})`, ''];
    const name = data.backupLocation?.name ?? data.mountPathName ?? data.name ?? '?';
    lines.push(`**Name:** ${name}`);
    if (data.mediaAgent?.name) lines.push(`**Media Agent:** ${data.mediaAgent.name}`);
    if (data.access !== undefined) lines.push(`**Access:** ${data.access}`);
    if (data.diskFreeSpace !== undefined) lines.push(`**Freier Speicher:** ${formatSize(data.diskFreeSpace)}`);
    if (data.diskCapacity !== undefined) lines.push(`**Kapazitat:** ${formatSize(data.diskCapacity)}`);

    // Access paths
    const accessPaths = data.accessPathList ?? data.accessPaths ?? [];
    if (accessPaths.length > 0) {
      lines.push('', '**Access Paths:**');
      for (const ap of accessPaths) {
        const maName = ap.mediaAgent?.name ?? ap.name ?? '?';
        lines.push(`  - ${maName}${ap.accessible !== undefined ? ` [${ap.accessible ? 'online' : 'offline'}]` : ''}`);
      }
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── 12. mountContent — Mount Path Content ──

  async mountContent(input: Record<string, unknown>): Promise<SkillResult> {
    // The API uses query params for filtering; we pass known ones through
    const params = new URLSearchParams();
    if (input.mountPathId) params.set('mountPathId', String(input.mountPathId));
    if (input.libraryId) params.set('libraryId', String(input.libraryId));
    if (input.mediaAgentId) params.set('mediaAgentId', String(input.mediaAgentId));
    const qs = params.toString() ? `?${params.toString()}` : '';

    const data = await this.api.get<any>(`/V4/MountPath/Content${qs}`);

    const lines = ['## Mount Path Content', ''];
    if (data.mountpathName) lines.push(`**Mount Path:** ${data.mountpathName}`);
    if (data.totalSizeOnMedia !== undefined) lines.push(`**Daten auf Media:** ${formatSize(data.totalSizeOnMedia / (1024 * 1024))}`);
    if (data.totalDataWritten !== undefined) lines.push(`**Geschriebene Daten:** ${formatSize(data.totalDataWritten / (1024 * 1024))}`);
    if (data.isRequiredByAuxiliaryCopy !== undefined) lines.push(`**Aux-Copy erforderlich:** ${data.isRequiredByAuxiliaryCopy ? 'ja' : 'nein'}`);
    if (data.isSingleInstanced !== undefined) lines.push(`**DDB-Referenzen:** ${data.isSingleInstanced ? 'ja' : 'nein'}`);

    const jobs = data.jobInfoList ?? [];
    if (jobs.length > 0) {
      lines.push('', `**Jobs auf Mount Path:** ${jobs.length}`);
      for (const j of jobs.slice(0, 15)) {
        const jobId = j.jobId ?? j.id ?? '?';
        const size = j.sizeOnMedia ?? j.size ?? 0;
        lines.push(`  - Job ${jobId}${size > 0 ? ` (${formatSize(size / (1024 * 1024))})` : ''}`);
      }
      if (jobs.length > 15) lines.push(`  ... und ${jobs.length - 15} weitere`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── Private helpers ───────────────────────────────────────

  private resolveTypePath(storageType: string): string {
    const t = storageType.toLowerCase();
    if (t === 'cloud') return 'Cloud';
    if (t === 'local') return 'Local';
    if (t === 'hyperscale') return 'HyperScale';
    if (t === 'tape') return 'Tape';
    return 'Disk';
  }
}
