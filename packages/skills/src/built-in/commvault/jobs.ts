/**
 * Commvault Jobs Module — 7 actions for backup job management
 *
 * API response field mapping:
 *   GET /Job                              → { jobs: JobSummary[] }
 *   GET /Job/{jobId}                      → { jobs: [{ jobSummary: {...} }] }
 *   GET /Job/{jobId}/Details              → { job: { jobDetail: {...} } }
 *   POST /Subclient/{id}/action/backup    → { jobIds: [...], taskId: ... }
 *   POST /Job/{jobId}/action/kill         → { errList?: [...] }
 *   GET /v4/Cloud/CloudConfig/Job/{id}/Browse → { browseResult: {...} }
 *
 * JobSummary: { jobId, status, subclient.clientName, subclient.subclientName,
 *               sizeOfApplication (bytes), jobStartTime/jobEndTime (unix sec),
 *               backupLevel (1=full,2=incr,3=diff), errorCode, statusMessage }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { formatSize, requireId, optionalString } from './types.js';

// ── Known error codes ─────────────────────────────────────────
const KNOWN_ERRORS: Record<string, string> = {
  '7:66': 'VSS Snapshot failed',
  '7:40': 'Network error',
  '7:64': 'Storage write error',
  '7:80': 'Client not responding',
  '9:40': 'Restore target disk full',
  '7:69': 'File locked',
  '7:101': 'DDB corrupt/full',
};

// ── Helper: format duration in seconds to human-readable ──────
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Helper: bytes to MB for formatSize ────────────────────────
function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

// ── Helper: status icon ───────────────────────────────────────
function statusIcon(status: string): string {
  const s = (status ?? '').toLowerCase();
  if (s.includes('completed') && !s.includes('error') && !s.includes('warning')) return '[OK]';
  if (s.includes('running') || s.includes('active')) return '[>>]';
  if (s.includes('pending') || s.includes('waiting') || s.includes('queued')) return '[..]';
  if (s.includes('failed') || s.includes('killed') || s.includes('error')) return '[!!]';
  if (s.includes('warning') || s.includes('partial')) return '[!]';
  if (s.includes('suspended') || s.includes('paused')) return '[||]';
  return '[--]';
}

// ── Helper: backup level to string ────────────────────────────
function backupLevelName(level: number): string {
  if (level === 1) return 'Full';
  if (level === 2) return 'Incremental';
  if (level === 3) return 'Differential';
  return `Level ${level}`;
}

export class CommvaultJobs {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Backup Jobs auflisten ─────────────────────────

  async list(input: Record<string, unknown>): Promise<SkillResult> {
    const hours = typeof input.hours === 'number' ? input.hours : 24;
    const lookupTime = hours * 3600;
    const filterStatus = optionalString(input, 'status');
    const filterClient = optionalString(input, 'client');

    const data = await this.api.get<any>(
      `/Job?completedJobLookupTime=${lookupTime}&jobFilter=Backup`,
    );
    let jobs: any[] = data.jobs ?? [];

    // Extract jobSummary from each entry
    jobs = jobs.map((j: any) => j.jobSummary ?? j);

    // Apply filters
    if (filterStatus) {
      const s = filterStatus.toLowerCase();
      jobs = jobs.filter((j: any) => (j.status ?? '').toLowerCase().includes(s));
    }
    if (filterClient) {
      const c = filterClient.toLowerCase();
      jobs = jobs.filter(
        (j: any) => (j.subclient?.clientName ?? '').toLowerCase().includes(c),
      );
    }

    const lines = ['## Commvault Backup Jobs', `${jobs.length} Jobs (letzte ${hours}h)`, ''];

    for (const j of jobs.slice(0, 50)) {
      const icon = statusIcon(j.status ?? '');
      const client = j.subclient?.clientName ?? '?';
      const size = j.sizeOfApplication ? formatSize(bytesToMB(j.sizeOfApplication)) : '-';
      const start = j.jobStartTime ?? 0;
      const end = j.jobEndTime ?? 0;
      const duration = start > 0 && end > start ? formatDuration(end - start) : (start > 0 ? 'laufend' : '-');

      lines.push(
        `${icon} Job **${j.jobId ?? '?'}** — ${j.status ?? '?'} | ${client} | ${size} | ${duration}`,
      );
    }

    if (jobs.length > 50) lines.push(`\n... und ${jobs.length - 50} weitere Jobs`);

    return {
      success: true,
      data: { total: jobs.length, jobs: jobs.slice(0, 50) },
      display: lines.join('\n'),
    };
  }

  // ── 2. detail — Job Detail ──────────────────────────────────

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = requireId(input, 'job_id');

    const [summaryRes, detailRes] = await Promise.allSettled([
      this.api.get<any>(`/Job/${jobId}`),
      this.api.get<any>(`/Job/${jobId}/Details`),
    ]);

    const summaryData = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
    const detailData = detailRes.status === 'fulfilled' ? detailRes.value : null;

    const summary = summaryData?.jobs?.[0]?.jobSummary ?? {};
    const detail = detailData?.job?.jobDetail ?? {};

    const lines = [`## Job ${jobId} — Detail`, ''];
    lines.push(`**Status:** ${statusIcon(summary.status ?? '')} ${summary.status ?? '?'}`);
    if (summary.statusMessage) lines.push(`**Meldung:** ${summary.statusMessage}`);

    const client = summary.subclient?.clientName ?? '?';
    const subclient = summary.subclient?.subclientName ?? '';
    lines.push(`**Client:** ${client}${subclient ? ` / ${subclient}` : ''}`);

    if (summary.backupLevel) lines.push(`**Backup-Level:** ${backupLevelName(summary.backupLevel)}`);

    // Timing
    if (summary.jobStartTime) {
      const startDate = new Date(summary.jobStartTime * 1000).toLocaleString('de-AT');
      lines.push(`**Start:** ${startDate}`);
    }
    if (summary.jobEndTime && summary.jobEndTime > 0) {
      const endDate = new Date(summary.jobEndTime * 1000).toLocaleString('de-AT');
      lines.push(`**Ende:** ${endDate}`);
    }
    if (summary.jobStartTime && summary.jobEndTime && summary.jobEndTime > summary.jobStartTime) {
      lines.push(`**Dauer:** ${formatDuration(summary.jobEndTime - summary.jobStartTime)}`);
    }

    // Size
    if (summary.sizeOfApplication) {
      lines.push(`**Datenmenge:** ${formatSize(bytesToMB(summary.sizeOfApplication))}`);
    }

    // Progress
    const progress = summary.percentComplete ?? summary.percentagComplete ?? detail.progressInfo?.percentComplete;
    if (progress !== undefined) {
      lines.push(`**Fortschritt:** ${progress}%`);
    }

    // File counts from detail
    const fileInfo = detail.progressInfo ?? detail.detailInfo ?? {};
    if (fileInfo.totalNumOfFiles !== undefined) {
      lines.push(`**Dateien:** ${fileInfo.totalNumOfFiles} gesamt`);
    }
    if (fileInfo.numOfFailedFiles !== undefined && fileInfo.numOfFailedFiles > 0) {
      lines.push(`**Fehlgeschlagene Dateien:** ${fileInfo.numOfFailedFiles}`);
    }
    if (fileInfo.numOfSkippedFiles !== undefined && fileInfo.numOfSkippedFiles > 0) {
      lines.push(`**Uebersprungene Dateien:** ${fileInfo.numOfSkippedFiles}`);
    }

    // Error code
    if (summary.errorCode) {
      const errKey = summary.errorCode;
      const errDesc = KNOWN_ERRORS[errKey] ?? 'Unbekannter Fehler';
      lines.push(`**Fehlercode:** ${errKey} (${errDesc})`);
    }

    return {
      success: true,
      data: { summary, detail },
      display: lines.join('\n'),
    };
  }

  // ── 3. history — Job History (7 Tage) ──────────────────────

  async history(input: Record<string, unknown>): Promise<SkillResult> {
    const days = typeof input.days === 'number' ? input.days : 7;
    const lookupTime = days * 86400;

    const data = await this.api.get<any>(
      `/Job?completedJobLookupTime=${lookupTime}`,
    );
    const jobs: any[] = (data.jobs ?? []).map((j: any) => j.jobSummary ?? j);

    // Group by client
    const byClient = new Map<string, { success: number; failed: number; lastTime: number }>();

    for (const j of jobs) {
      const client = j.subclient?.clientName ?? 'Unbekannt';
      const entry = byClient.get(client) ?? { success: 0, failed: 0, lastTime: 0 };

      const status = (j.status ?? '').toLowerCase();
      if (status.includes('completed') && !status.includes('error') && !status.includes('warning')) {
        entry.success++;
      } else if (status.includes('failed') || status.includes('killed') || status.includes('error')) {
        entry.failed++;
      }

      const endTime = j.jobEndTime ?? j.jobStartTime ?? 0;
      if (endTime > entry.lastTime) entry.lastTime = endTime;

      byClient.set(client, entry);
    }

    // Sort by failed desc, then by name
    const sorted = [...byClient.entries()].sort((a, b) => {
      if (b[1].failed !== a[1].failed) return b[1].failed - a[1].failed;
      return a[0].localeCompare(b[0]);
    });

    const totalSuccess = sorted.reduce((s, [, v]) => s + v.success, 0);
    const totalFailed = sorted.reduce((s, [, v]) => s + v.failed, 0);

    const lines = [
      '## Backup History',
      `${days} Tage | ${jobs.length} Jobs | ${sorted.length} Clients`,
      `Erfolgreich: ${totalSuccess} | Fehlgeschlagen: ${totalFailed}`,
      '',
    ];

    for (const [client, stats] of sorted) {
      const lastBackup = stats.lastTime > 0
        ? new Date(stats.lastTime * 1000).toLocaleString('de-AT')
        : 'nie';
      const warn = stats.failed > 0 ? ' [!!]' : '';
      lines.push(
        `**${client}**${warn} — OK: ${stats.success}, Fehler: ${stats.failed} | Letztes Backup: ${lastBackup}`,
      );
    }

    return {
      success: true,
      data: { totalJobs: jobs.length, clients: sorted.length, totalSuccess, totalFailed, byClient: Object.fromEntries(byClient) },
      display: lines.join('\n'),
    };
  }

  // ── 4. start — Backup starten ───────────────────────────────

  async start(input: Record<string, unknown>): Promise<SkillResult> {
    const subclientId = requireId(input, 'subclient_id');
    const levelInput = typeof input.level === 'number' ? input.level : undefined;
    const levelStr = optionalString(input, 'level');

    let backupLevel = 2; // default: incremental
    if (levelInput !== undefined) {
      backupLevel = levelInput;
    } else if (levelStr) {
      const l = levelStr.toLowerCase();
      if (l === 'full') backupLevel = 1;
      else if (l === 'incremental' || l === 'incr') backupLevel = 2;
      else if (l === 'differential' || l === 'diff') backupLevel = 3;
    }

    const body = {
      taskInfo: {
        subTasks: [
          {
            options: {
              backupOpts: {
                backupLevel,
              },
            },
          },
        ],
      },
    };

    const result = await this.api.post<any>(
      `/Subclient/${subclientId}/action/backup`,
      body as unknown as Record<string, unknown>,
    );

    const jobIds = result.jobIds ?? [];
    return {
      success: true,
      data: result,
      display: `Backup gestartet (${backupLevelName(backupLevel)}) fuer Subclient ${subclientId}.\nJob-IDs: ${jobIds.length > 0 ? jobIds.join(', ') : result.taskId ?? '?'}`,
    };
  }

  // ── 5. stop — Job stoppen ───────────────────────────────────

  async stop(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = requireId(input, 'job_id');

    const result = await this.api.post<any>(`/Job/${jobId}/action/kill`);

    const errors = result.errList ?? [];
    if (errors.length > 0) {
      const errMsgs = errors.map((e: any) => e.errLogMessage ?? e.errorMessage ?? JSON.stringify(e));
      return {
        success: false,
        data: result,
        error: `Job ${jobId} konnte nicht gestoppt werden: ${errMsgs.join('; ')}`,
      };
    }

    return {
      success: true,
      data: result,
      display: `Job ${jobId} wurde gestoppt.`,
    };
  }

  // ── 6. retry — Fehlgeschlagenen Job erneut starten ──────────

  async retry(input: Record<string, unknown>): Promise<SkillResult> {
    const subclientId = requireId(input, 'subclient_id');
    const levelInput = typeof input.level === 'number' ? input.level : undefined;
    const levelStr = optionalString(input, 'level');

    let backupLevel = 2;
    if (levelInput !== undefined) {
      backupLevel = levelInput;
    } else if (levelStr) {
      const l = levelStr.toLowerCase();
      if (l === 'full') backupLevel = 1;
      else if (l === 'incremental' || l === 'incr') backupLevel = 2;
      else if (l === 'differential' || l === 'diff') backupLevel = 3;
    }

    const body = {
      taskInfo: {
        subTasks: [
          {
            options: {
              backupOpts: {
                backupLevel,
              },
            },
          },
        ],
      },
    };

    const result = await this.api.post<any>(
      `/Subclient/${subclientId}/action/backup`,
      body as unknown as Record<string, unknown>,
    );

    const jobIds = result.jobIds ?? [];
    return {
      success: true,
      data: result,
      display: `Retry-Backup gestartet (${backupLevelName(backupLevel)}) fuer Subclient ${subclientId}.\nJob-IDs: ${jobIds.length > 0 ? jobIds.join(', ') : result.taskId ?? '?'}`,
    };
  }

  // ── 7. browse — Job-Inhalte durchsuchen ─────────────────────

  async browse(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = requireId(input, 'job_id');

    const data = await this.api.get<any>(`/v4/Cloud/CloudConfig/Job/${jobId}/Browse`);
    const browseResult = data.browseResult ?? data;
    const entries = browseResult.dataResultSet ?? browseResult.browseResponses ?? [];

    const lines = [`## Browse Job ${jobId}`, `${entries.length} Eintraege`, ''];

    for (const entry of entries.slice(0, 30)) {
      const name = entry.displayName ?? entry.name ?? entry.path ?? '?';
      const size = entry.size ? formatSize(bytesToMB(entry.size)) : '';
      const type = entry.flags?.directory ? 'Ordner' : 'Datei';
      lines.push(`- [${type}] ${name}${size ? ` (${size})` : ''}`);
    }

    if (entries.length > 30) lines.push(`\n... und ${entries.length - 30} weitere Eintraege`);

    return {
      success: true,
      data: browseResult,
      display: lines.join('\n'),
    };
  }
}
