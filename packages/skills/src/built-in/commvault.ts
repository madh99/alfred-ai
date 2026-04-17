import type { SkillMetadata, SkillContext, SkillResult, CommvaultConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action =
  | 'status' | 'jobs' | 'job_detail' | 'clients' | 'client_detail'
  | 'storage' | 'alerts' | 'report' | 'analyze'
  | 'start_job' | 'stop_job' | 'retry_job' | 'restore' | 'modify_schedule' | 'configure';

type SkillCallback = (input: Record<string, unknown>) => Promise<SkillResult>;

// ── Known Commvault error codes for LLM analysis context ──
const ERROR_CODE_HINTS: Record<string, string> = {
  '7:66': 'VSS Snapshot fehlgeschlagen — Writer-Timeout oder App blockiert',
  '7:40': 'Netzwerkfehler zwischen Client und MediaAgent',
  '7:64': 'Backup-Daten konnten nicht geschrieben werden — Storage voll oder I/O Fehler',
  '7:80': 'Client-Prozess reagiert nicht — Agent-Dienst prüfen',
  '9:40': 'Restore fehlgeschlagen — Zieldisk voll',
  '7:69': 'Datei gesperrt — Applikation hält File-Lock',
  '7:101': 'Deduplizierung fehlgeschlagen — DDB korrupt oder voll',
};

export class CommvaultSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'commvault',
    category: 'infrastructure',
    description:
      'Commvault Backup Management — CommServe REST API v2. ' +
      '"status" zeigt Gesamtübersicht (fehlgeschlagene Jobs, Alerts, Storage). ' +
      '"jobs" listet Backup-Jobs (filter: status, client, hours). ' +
      '"job_detail" zeigt Job-Details mit Logs. ' +
      '"clients" listet alle Clients mit letztem Backup-Status. ' +
      '"client_detail" zeigt Client mit Subclients, Schedules, Recovery Points. ' +
      '"storage" zeigt Storage Pools mit Kapazität + Wachstumsprognose. ' +
      '"alerts" zeigt aktive Warnungen. ' +
      '"report" erstellt SLA/Compliance-Report. ' +
      '"analyze" LLM-basierte Fehleranalyse + Optimierungsvorschläge. ' +
      '"start_job" startet Backup. "stop_job" stoppt Job. "retry_job" startet fehlgeschlagenen Job neu. ' +
      '"restore" löst Restore aus. "modify_schedule" ändert Backup-Schedule. ' +
      '"configure" ändert Skill-Einstellungen.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'jobs', 'job_detail', 'clients', 'client_detail', 'storage', 'alerts', 'report', 'analyze', 'start_job', 'stop_job', 'retry_job', 'restore', 'modify_schedule', 'configure'] },
        job_id: { type: 'number', description: 'Job ID (für job_detail, stop_job, retry_job)' },
        client: { type: 'string', description: 'Client-Name oder ID' },
        subclient: { type: 'string', description: 'Subclient-Name (für start_job)' },
        status: { type: 'string', description: 'Job-Status Filter: failed, running, completed, all' },
        hours: { type: 'number', description: 'Zeitraum in Stunden (default 24)' },
        level: { type: 'string', description: 'Backup-Level: full, incremental, differential' },
        severity: { type: 'string', description: 'Alert-Severity: critical, warning, info' },
        period: { type: 'string', description: 'Report-Zeitraum: day, week, month' },
        focus: { type: 'string', description: 'Analyse-Fokus: failures, storage, schedules, all' },
        point_in_time: { type: 'string', description: 'Restore Zeitpunkt (ISO)' },
        destination: { type: 'string', description: 'Restore Ziel-Client' },
        overwrite: { type: 'boolean', description: 'Restore: bestehende Daten überschreiben' },
        schedule_name: { type: 'string', description: 'Schedule-Name (für modify_schedule)' },
        frequency: { type: 'string', description: 'Neue Frequenz (für modify_schedule)' },
        filter: { type: 'string', description: 'Name-Filter Pattern' },
        // configure params
        confirmation_mode: { type: 'boolean' },
        polling_interval: { type: 'number' },
        auto_retry_failed: { type: 'boolean' },
        auto_incident: { type: 'boolean' },
      },
      required: ['action'],
    },
  };

  private config: CommvaultConfig;
  private authToken: string | null = null;
  private tokenExpiresAt = 0;
  private itsmCallback?: SkillCallback;

  constructor(config: CommvaultConfig) {
    super();
    this.config = { ...config };
  }

  setItsmCallback(cb: SkillCallback): void { this.itsmCallback = cb; }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;

    // Write actions: check confirmation_mode
    const writeActions = new Set<Action>(['start_job', 'stop_job', 'retry_job', 'restore', 'modify_schedule']);
    if (writeActions.has(action) && this.config.confirmation_mode) {
      return {
        success: true,
        data: { requiresConfirmation: true, action, input },
        display: `⚠️ **Bestätigung erforderlich** — ${action} ist im Bestätigungsmodus. Bitte bestätige die Aktion.`,
      };
    }

    switch (action) {
      case 'status': return this.getStatus();
      case 'jobs': return this.getJobs(input);
      case 'job_detail': return this.getJobDetail(input);
      case 'clients': return this.getClients(input);
      case 'client_detail': return this.getClientDetail(input);
      case 'storage': return this.getStorage();
      case 'alerts': return this.getAlerts(input);
      case 'report': return this.getReport(input);
      case 'analyze': return this.analyze(input);
      case 'start_job': return this.startJob(input);
      case 'stop_job': return this.stopJob(input);
      case 'retry_job': return this.retryJob(input);
      case 'restore': return this.doRestore(input);
      case 'modify_schedule': return this.modifySchedule(input);
      case 'configure': return this.doConfigure(input);
      default: return { success: false, error: `Unknown action "${action}"` };
    }
  }

  // ── Auth ────────────────────────────────────────────────────

  private async ensureAuth(): Promise<string> {
    if (this.authToken && Date.now() < this.tokenExpiresAt) return this.authToken;

    if (this.config.apiToken) {
      this.authToken = this.config.apiToken;
      this.tokenExpiresAt = Date.now() + 24 * 60 * 60_000;
      return this.authToken;
    }

    if (this.config.username && this.config.password) {
      const res = await this.apiRaw('POST', '/Login', {
        username: this.config.username,
        password: this.config.password,
      });
      const data = await res.json() as Record<string, unknown>;
      this.authToken = data.token as string;
      this.tokenExpiresAt = Date.now() + 55 * 60_000; // refresh before 60min expiry
      return this.authToken;
    }

    throw new Error('Commvault: Keine Authentifizierung konfiguriert (apiToken oder username/password)');
  }

  private async apiRaw(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (this.authToken) headers.Authtoken = this.authToken;

    const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const skipTls = this.config.verifyTls === false;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      return await fetch(url, opts);
    } finally {
      if (skipTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }

  private async api<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    await this.ensureAuth();
    const res = await this.apiRaw(method, path, body);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Commvault API ${method} ${path}: HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }
    return await res.json() as T;
  }

  // ── Read Actions ───────────────────────────────────────────

  private async getStatus(): Promise<SkillResult> {
    const [jobsData, alertsData, storageData] = await Promise.all([
      this.api<any>('GET', '/Job?completedJobLookupTime=86400&jobFilter=Backup'),
      this.api<any>('GET', '/V4/TriggeredAlerts').catch(() =>
        this.api<any>('GET', '/AlertRule').catch(() => ({}))
      ),
      this.api<any>('GET', '/V4/Storage/Disk').catch(() =>
        this.api<any>('GET', '/StoragePool').catch(() => ({}))
      ),
    ]);

    const jobs = jobsData.jobs ?? jobsData.jobList ?? [];
    const failed = jobs.filter((j: any) => j.jobSummary?.status === 'Failed' || j.status === 'Failed');
    const running = jobs.filter((j: any) => j.jobSummary?.status === 'Running' || j.status === 'Running');
    const completed = jobs.filter((j: any) => j.jobSummary?.status === 'Completed' || j.status === 'Completed');

    const alerts = alertsData.alertsTriggered ?? alertsData.alertList ?? alertsData.alerts ?? [];
    const criticalAlerts = alerts.filter((a: any) => {
      const sev = typeof a.severity === 'string' ? a.severity.toUpperCase() : '';
      return sev === 'CRITICAL' || a.severity === 1;
    });

    // V4: { diskStorage: [{ name, capacity (MB), freeSpace (MB) }] }
    // Legacy: { storagePoolList: [{ storagePoolEntity: { storagePoolName }, totalCapacity (bytes) }] }
    const isV4Storage = !!storageData.diskStorage;
    const pools = storageData.diskStorage ?? storageData.storagePoolList ?? storageData.storagePools ?? [];
    const storageLines: string[] = [];
    for (const p of pools.slice(0, 5)) {
      const name = isV4Storage ? (p.name ?? '?') : (p.storagePoolEntity?.storagePoolName ?? p.storagePoolName ?? p.name ?? '?');
      const totalMB = isV4Storage ? (p.capacity ?? 0) : ((p.totalCapacity ?? 0) / 1024 / 1024);
      const freeMB = isV4Storage ? (p.freeSpace ?? 0) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024);
      const totalGB = Math.round(totalMB / 1024);
      const freeGB = Math.round(freeMB / 1024);
      const usedPct = totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;
      const warn = usedPct >= (this.config.storage_warning_pct ?? 85) ? ' ⚠️' : '';
      storageLines.push(`  ${name}: ${usedPct}% belegt (${freeGB} GB frei)${warn}`);
    }

    return {
      success: true,
      data: { failed: failed.length, running: running.length, completed: completed.length, alerts: criticalAlerts.length },
      display: [
        '## Commvault Status',
        '',
        `**Jobs (24h):** ${completed.length} erfolgreich, ${running.length} laufend, ${failed.length} fehlgeschlagen`,
        `**Alerts:** ${criticalAlerts.length} kritisch, ${alerts.length} gesamt`,
        storageLines.length ? `**Storage:**\n${storageLines.join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  private async getJobs(input: Record<string, unknown>): Promise<SkillResult> {
    const hours = (input.hours as number) ?? 24;
    const statusFilter = input.status as string | undefined;
    const clientFilter = input.client as string | undefined;

    const data = await this.api<any>('GET', `/Job?completedJobLookupTime=${hours * 3600}&jobFilter=Backup`);
    let jobs = data.jobs ?? data.jobList ?? [];

    if (statusFilter && statusFilter !== 'all') {
      jobs = jobs.filter((j: any) => {
        const s = (j.jobSummary?.status ?? j.status ?? '').toLowerCase();
        return s.includes(statusFilter.toLowerCase());
      });
    }
    if (clientFilter) {
      jobs = jobs.filter((j: any) => {
        const c = j.jobSummary?.subclient?.clientName ?? j.clientName ?? '';
        return c.toLowerCase().includes(clientFilter.toLowerCase());
      });
    }

    const lines = ['## Backup Jobs', `Zeitraum: letzte ${hours}h | ${jobs.length} Jobs`, ''];
    for (const job of jobs.slice(0, 30)) {
      const s = job.jobSummary ?? job;
      const id = s.jobId ?? job.jobId ?? '?';
      const status = s.status ?? '?';
      const client = s.subclient?.clientName ?? s.clientName ?? '?';
      const subclient = s.subclient?.subclientName ?? '';
      const sizeMB = Math.round((s.sizeOfApplication ?? 0) / 1024 / 1024);
      const icon = status === 'Completed' ? '✅' : status === 'Running' ? '🔄' : status === 'Failed' ? '❌' : '⚪';
      lines.push(`${icon} **${id}** ${client}${subclient ? `/${subclient}` : ''} — ${status} (${sizeMB} MB)`);
    }
    return { success: true, data: { count: jobs.length }, display: lines.join('\n') };
  }

  private async getJobDetail(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = input.job_id as number;
    if (!jobId) return { success: false, error: 'Missing job_id' };

    const data = await this.api<any>('GET', `/Job/${jobId}`);
    const job = data.jobSummary ?? data;
    const details = await this.api<any>('GET', `/Job/${jobId}/Details`).catch(() => null);

    const status = job.status ?? '?';
    const client = job.subclient?.clientName ?? '?';
    const subclient = job.subclient?.subclientName ?? '';
    const startTime = job.startTime ? new Date(job.startTime * 1000).toISOString() : '?';
    const endTime = job.endTime ? new Date(job.endTime * 1000).toISOString() : 'laufend';
    const sizeMB = Math.round((job.sizeOfApplication ?? 0) / 1024 / 1024);
    const errorCode = job.errorCode ?? job.statusMessage ?? '';
    const errorHint = ERROR_CODE_HINTS[errorCode] ?? '';

    const lines = [
      `## Job ${jobId}`,
      '',
      `**Status:** ${status}`,
      `**Client:** ${client}${subclient ? `/${subclient}` : ''}`,
      `**Start:** ${startTime}`,
      `**Ende:** ${endTime}`,
      `**Größe:** ${sizeMB} MB`,
    ];

    if (errorCode) lines.push(`**Fehler:** ${errorCode}${errorHint ? ` — ${errorHint}` : ''}`);
    if (details?.jobDetail?.progressInfo) {
      const pct = details.jobDetail.progressInfo.percentComplete ?? 0;
      lines.push(`**Fortschritt:** ${pct}%`);
    }

    return { success: true, data: job, display: lines.join('\n') };
  }

  private async getClients(input: Record<string, unknown>): Promise<SkillResult> {
    const data = await this.api<any>('GET', '/Client');
    let clients = data.clientProperties ?? data.clients ?? [];
    const filter = input.filter as string | undefined;
    if (filter) {
      clients = clients.filter((c: any) => {
        const name = c.client?.clientEntity?.clientName ?? c.clientName ?? '';
        return name.toLowerCase().includes(filter.toLowerCase());
      });
    }

    const lines = ['## Commvault Clients', `${clients.length} Clients`, ''];
    for (const c of clients.slice(0, 30)) {
      const name = c.client?.clientEntity?.clientName ?? c.clientName ?? '?';
      const os = c.client?.osInfo?.OsDisplayInfo?.OSName ?? '';
      lines.push(`- **${name}**${os ? ` (${os})` : ''}`);
    }
    return { success: true, data: { count: clients.length }, display: lines.join('\n') };
  }

  private async getClientDetail(input: Record<string, unknown>): Promise<SkillResult> {
    const clientName = input.client as string;
    if (!clientName) return { success: false, error: 'Missing client name' };

    // Find client ID
    const clientsData = await this.api<any>('GET', '/Client');
    const allClients = clientsData.clientProperties ?? clientsData.clients ?? [];
    const match = allClients.find((c: any) => {
      const name = c.client?.clientEntity?.clientName ?? c.clientName ?? '';
      return name.toLowerCase() === clientName.toLowerCase();
    });
    if (!match) return { success: false, error: `Client "${clientName}" nicht gefunden` };
    const clientId = match.client?.clientEntity?.clientId ?? match.clientId;

    // Get subclients
    const subclients = await this.api<any>('GET', `/Subclient?clientId=${clientId}`).catch(() => ({ subClientProperties: [] }));
    const subs = subclients.subClientProperties ?? [];

    // Get recent jobs for this client
    const jobsData = await this.api<any>('GET', `/Job?clientId=${clientId}&completedJobLookupTime=604800&jobFilter=Backup`);
    const jobs = (jobsData.jobs ?? jobsData.jobList ?? []).slice(0, 10);

    const lines = [
      `## Client: ${clientName}`,
      '',
      `**Subclients:** ${subs.length}`,
    ];
    for (const s of subs.slice(0, 10)) {
      const name = s.subClientEntity?.subclientName ?? '?';
      lines.push(`  - ${name}`);
    }

    lines.push('', `**Letzte Jobs (7d):**`);
    for (const j of jobs) {
      const s = j.jobSummary ?? j;
      const status = s.status ?? '?';
      const id = s.jobId ?? '?';
      const icon = status === 'Completed' ? '✅' : status === 'Failed' ? '❌' : '🔄';
      lines.push(`  ${icon} Job ${id}: ${status}`);
    }

    return { success: true, data: { clientId, subclients: subs.length, recentJobs: jobs.length }, display: lines.join('\n') };
  }

  private async getStorage(): Promise<SkillResult> {
    // V4 endpoint: /V4/Storage/Disk returns { diskStorage: [...] } with capacity in MB
    // Fallback: legacy /StoragePool returns { storagePoolList: [...] } with capacity in bytes
    let pools: any[] = [];
    let isV4 = false;
    try {
      const v4Data = await this.api<any>('GET', '/V4/Storage/Disk');
      pools = v4Data.diskStorage ?? [];
      isV4 = pools.length > 0;
    } catch { /* V4 not available */ }
    if (!isV4) {
      try {
        const legacyData = await this.api<any>('GET', '/StoragePool');
        pools = legacyData.storagePoolList ?? legacyData.storagePools ?? [];
      } catch { /* skip */ }
    }

    const lines = ['## Commvault Storage', ''];
    for (const p of pools) {
      const name = isV4 ? (p.name ?? '?') : (p.storagePoolEntity?.storagePoolName ?? p.storagePoolName ?? p.name ?? '?');
      const poolId = isV4 ? (p.id ?? '') : (p.storagePoolEntity?.storagePoolId ?? '');
      const status = p.status ?? '';
      // V4: capacity/freeSpace in MB. Legacy: totalCapacity/totalFreeSpace in bytes
      const totalMB = isV4 ? (p.capacity ?? 0) : ((p.totalCapacity ?? 0) / 1024 / 1024);
      const freeMB = isV4 ? (p.freeSpace ?? 0) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024);
      const totalGB = (totalMB / 1024).toFixed(1);
      const freeGB = (freeMB / 1024).toFixed(1);
      const usedPct = totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;
      const warn = usedPct >= (this.config.storage_warning_pct ?? 85) ? ' ⚠️ WARNUNG' : '';
      lines.push(`**${name}**${poolId ? ` (ID: ${poolId})` : ''}${status ? ` [${status}]` : ''}${warn}:`);
      lines.push(`  ${usedPct}% belegt | ${freeGB} GB frei von ${totalGB} GB`);
    }

    return { success: true, data: { pools: pools.length }, display: lines.join('\n') };
  }

  private async getAlerts(input: Record<string, unknown>): Promise<SkillResult> {
    // Use triggered alerts endpoint (not AlertRule which lists definitions)
    let data: any;
    try {
      data = await this.api<any>('GET', '/V4/TriggeredAlerts');
    } catch {
      // Fallback to legacy endpoint if V4 not available
      try { data = await this.api<any>('GET', '/AlertRule'); } catch { data = {}; }
    }

    // V4 response: { alertsTriggered: [...], totalCount, unreadCount }
    // Legacy response: { alertList: [...] }
    let alerts = data.alertsTriggered ?? data.alertList ?? data.alerts ?? [];
    const totalCount = data.totalCount ?? alerts.length;
    const unreadCount = data.unreadCount ?? 0;

    const severity = input.severity as string | undefined;
    if (severity) {
      const sevLower = severity.toLowerCase();
      alerts = alerts.filter((a: any) => {
        const s = typeof a.severity === 'string' ? a.severity.toLowerCase() : '';
        if (sevLower === 'critical') return s === 'critical';
        if (sevLower === 'warning' || sevLower === 'major') return s === 'major';
        if (sevLower === 'info') return s === 'information';
        return true;
      });
    }

    const lines = ['## Commvault Alerts', `${totalCount} gesamt, ${unreadCount} ungelesen`, ''];
    for (const a of alerts.slice(0, 20)) {
      // V4 severity is string: CRITICAL, MAJOR, INFORMATION
      const sevStr = typeof a.severity === 'string' ? a.severity.toUpperCase() : '';
      const sev = sevStr === 'CRITICAL' ? '🔴' : sevStr === 'MAJOR' ? '🟡' : '🔵';
      // V4 uses "info" for alert name, legacy uses "alertName"
      const name = a.info ?? a.alertName ?? a.name ?? '?';
      const notes = a.notes ?? a.description ?? '';
      const type = a.type ?? '';
      const client = a.client?.name ?? '';
      const time = a.detectedTime ? new Date(a.detectedTime * 1000).toLocaleString('de-AT') : '';
      lines.push(`${sev} **${name}**${type ? ` [${type}]` : ''}${client ? ` (${client})` : ''}${time ? ` ${time}` : ''}`);
      if (notes) lines.push(`  ${notes.slice(0, 120)}`);
    }
    return { success: true, data: { total: totalCount, unread: unreadCount, shown: Math.min(alerts.length, 20) }, display: lines.join('\n') };
  }

  private async getReport(input: Record<string, unknown>): Promise<SkillResult> {
    const period = input.period as string ?? 'week';
    const hours = period === 'day' ? 24 : period === 'month' ? 720 : 168;

    const jobsData = await this.api<any>('GET', `/Job?completedJobLookupTime=${hours * 3600}&jobFilter=Backup`);
    const jobs = jobsData.jobs ?? jobsData.jobList ?? [];

    const total = jobs.length;
    const completed = jobs.filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Completed').length;
    const failed = jobs.filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Failed').length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // SLA check: find clients without successful backup in sla_rpo_hours
    const rpoHours = this.config.sla_rpo_hours ?? 24;
    const clientLastSuccess = new Map<string, number>();
    for (const j of jobs) {
      const s = j.jobSummary ?? j;
      if (s.status !== 'Completed') continue;
      const client = s.subclient?.clientName ?? s.clientName ?? '';
      const endTime = (s.endTime ?? 0) * 1000;
      const prev = clientLastSuccess.get(client) ?? 0;
      if (endTime > prev) clientLastSuccess.set(client, endTime);
    }
    const rpoDeadline = Date.now() - rpoHours * 60 * 60_000;
    const slaViolations: string[] = [];
    for (const [client, lastSuccess] of clientLastSuccess) {
      if (lastSuccess < rpoDeadline) slaViolations.push(client);
    }

    const totalSizeTB = jobs.reduce((sum: number, j: any) => sum + ((j.jobSummary?.sizeOfApplication ?? j.sizeOfApplication ?? 0) / 1024 / 1024 / 1024 / 1024), 0);

    return {
      success: true,
      data: { total, completed, failed, successRate, slaViolations: slaViolations.length },
      display: [
        `## Backup-Report (${period})`,
        '',
        `**Erfolgsrate:** ${successRate}% (${completed}/${total})`,
        `**Fehlgeschlagen:** ${failed}`,
        `**Gesamtvolumen:** ${totalSizeTB.toFixed(2)} TB`,
        `**SLA-Verletzungen (RPO ${rpoHours}h):** ${slaViolations.length > 0 ? slaViolations.join(', ') : 'keine'}`,
      ].join('\n'),
    };
  }

  private async analyze(input: Record<string, unknown>): Promise<SkillResult> {
    const focus = (input.focus as string) ?? 'all';

    // Gather data for LLM
    const parts: string[] = [];

    if (focus === 'all' || focus === 'failures') {
      const jobsData = await this.api<any>('GET', '/Job?completedJobLookupTime=86400&jobFilter=Backup');
      const failed = (jobsData.jobs ?? jobsData.jobList ?? []).filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Failed');
      parts.push(`FEHLGESCHLAGENE JOBS (24h): ${failed.length}`);
      for (const j of failed.slice(0, 30)) {
        const s = j.jobSummary ?? j;
        const client = s.subclient?.clientName ?? '?';
        const err = s.errorCode ?? s.statusMessage ?? '?';
        const hint = ERROR_CODE_HINTS[err] ?? '';
        parts.push(`  - Job ${s.jobId}: ${client} — Fehler: ${err}${hint ? ` (${hint})` : ''}`);
      }
    }

    if (focus === 'all' || focus === 'storage') {
      let pools: any[] = []; let isV4S = false;
      try { const d = await this.api<any>('GET', '/V4/Storage/Disk'); pools = d.diskStorage ?? []; isV4S = pools.length > 0; } catch { /* V4 N/A */ }
      if (!isV4S) try { const d = await this.api<any>('GET', '/StoragePool'); pools = d.storagePoolList ?? []; } catch { /* skip */ }
      parts.push('STORAGE:');
      for (const p of pools) {
        const name = isV4S ? (p.name ?? '?') : (p.storagePoolEntity?.storagePoolName ?? p.storagePoolName ?? '?');
        const totalGB = isV4S ? ((p.capacity ?? 0) / 1024).toFixed(1) : ((p.totalCapacity ?? 0) / 1024 / 1024 / 1024).toFixed(1);
        const freeGB = isV4S ? ((p.freeSpace ?? 0) / 1024).toFixed(1) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024 / 1024).toFixed(1);
        parts.push(`  - ${name}: ${freeGB} GB frei von ${totalGB} GB`);
      }
    }

    // Return data for LLM to analyze (the LLM in the chat will process this)
    return {
      success: true,
      data: { rawAnalysis: parts.join('\n') },
      display: [
        '## Commvault Analyse',
        '',
        parts.join('\n'),
        '',
        '---',
        '*Bitte analysiere die obigen Daten: Fehlerursachen, Muster, Optimierungsvorschläge, Kapazitätsprognosen.*',
      ].join('\n'),
    };
  }

  // ── Write Actions ──────────────────────────────────────────

  private async startJob(input: Record<string, unknown>): Promise<SkillResult> {
    const clientName = input.client as string;
    if (!clientName) return { success: false, error: 'Missing client name' };

    // Resolve subclient ID
    const subclientId = await this.resolveSubclientId(clientName, input.subclient as string | undefined);
    if (!subclientId) return { success: false, error: `Subclient für "${clientName}" nicht gefunden` };

    const level = (input.level as string) ?? 'incremental';
    const backupLevel = level === 'full' ? 1 : level === 'differential' ? 3 : 2;

    await this.api('POST', `/Subclient/${subclientId}/action/backup`, {
      backupLevel,
    });

    return { success: true, display: `## Backup gestartet\n**Client:** ${clientName}\n**Level:** ${level}` };
  }

  private async stopJob(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = input.job_id as number;
    if (!jobId) return { success: false, error: 'Missing job_id' };
    await this.api('POST', `/Job/${jobId}/action/kill`);
    return { success: true, display: `Job **${jobId}** gestoppt.` };
  }

  private async retryJob(input: Record<string, unknown>): Promise<SkillResult> {
    const jobId = input.job_id as number;
    if (!jobId) return { success: false, error: 'Missing job_id' };

    // Get job details to find subclient
    const jobData = await this.api<any>('GET', `/Job/${jobId}`);
    const job = jobData.jobSummary ?? jobData;
    const subclientId = job.subclient?.subclientId;
    if (!subclientId) return { success: false, error: 'Kann Subclient für Retry nicht ermitteln' };

    await this.api('POST', `/Subclient/${subclientId}/action/backup`, {
      backupLevel: job.backupLevel ?? 2,
    });

    return { success: true, display: `## Retry gestartet\n**Original Job:** ${jobId}\n**Client:** ${job.subclient?.clientName ?? '?'}` };
  }

  private async doRestore(input: Record<string, unknown>): Promise<SkillResult> {
    const clientName = input.client as string;
    if (!clientName) return { success: false, error: 'Missing client name' };

    const subclientId = await this.resolveSubclientId(clientName, input.subclient as string | undefined);
    if (!subclientId) return { success: false, error: `Subclient für "${clientName}" nicht gefunden` };

    const restoreBody: Record<string, unknown> = {
      taskInfo: {
        task: { taskType: 1 }, // restore task
        subTasks: [{
          subTask: { subTaskType: 3, operationType: 1001 }, // restore operation
          options: {
            restoreOptions: {
              browseOption: { backupset: { clientName } },
              destination: {
                destClient: { clientName: (input.destination as string) ?? clientName },
                inPlace: !input.destination,
              },
              overwriteFiles: input.overwrite ?? false,
            },
          },
        }],
      },
    };

    if (input.point_in_time) {
      (restoreBody as any).taskInfo.subTasks[0].options.restoreOptions.browseOption.timeRange = {
        toTime: Math.floor(new Date(input.point_in_time as string).getTime() / 1000),
      };
    }

    await this.api('POST', '/CreateTask', restoreBody);
    return {
      success: true,
      display: `## Restore gestartet\n**Client:** ${clientName}\n**Ziel:** ${(input.destination as string) ?? clientName}\n**Zeitpunkt:** ${(input.point_in_time as string) ?? 'letzter Recovery Point'}`,
    };
  }

  private async modifySchedule(input: Record<string, unknown>): Promise<SkillResult> {
    // This is a simplified implementation — full schedule modification would need
    // schedule policy ID lookup and the complex Commvault schedule schema
    const client = input.client as string;
    const scheduleName = input.schedule_name as string;
    if (!client || !scheduleName) return { success: false, error: 'Missing client or schedule_name' };

    return {
      success: true,
      display: [
        '## Schedule-Änderung',
        '',
        `**Client:** ${client}`,
        `**Schedule:** ${scheduleName}`,
        input.frequency ? `**Neue Frequenz:** ${input.frequency}` : '',
        '',
        'Schedule-Änderungen über die REST API erfordern die Schedule Policy ID. Bitte über Command Center anpassen oder die Policy ID angeben.',
      ].filter(Boolean).join('\n'),
    };
  }

  private async doConfigure(input: Record<string, unknown>): Promise<SkillResult> {
    const changes: string[] = [];
    if (input.confirmation_mode !== undefined) { this.config.confirmation_mode = input.confirmation_mode as boolean; changes.push(`Bestätigungsmodus: ${input.confirmation_mode}`); }
    if (input.polling_interval !== undefined) { this.config.polling_interval = input.polling_interval as number; changes.push(`Polling-Intervall: ${input.polling_interval} Min`); }
    if (input.auto_retry_failed !== undefined) { this.config.auto_retry_failed = input.auto_retry_failed as boolean; changes.push(`Auto-Retry: ${input.auto_retry_failed}`); }
    if (input.auto_incident !== undefined) { this.config.auto_incident = input.auto_incident as boolean; changes.push(`Auto-Incident: ${input.auto_incident}`); }
    if (changes.length === 0) return { success: false, error: 'Keine Änderungen angegeben.' };
    return { success: true, display: `## Commvault-Konfiguration geändert\n\n${changes.map(c => `- ${c}`).join('\n')}` };
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async resolveSubclientId(clientName: string, subclientName?: string): Promise<number | null> {
    const clientsData = await this.api<any>('GET', '/Client');
    const allClients = clientsData.clientProperties ?? clientsData.clients ?? [];
    const match = allClients.find((c: any) => {
      const name = c.client?.clientEntity?.clientName ?? c.clientName ?? '';
      return name.toLowerCase() === clientName.toLowerCase();
    });
    if (!match) return null;
    const clientId = match.client?.clientEntity?.clientId ?? match.clientId;

    const subData = await this.api<any>('GET', `/Subclient?clientId=${clientId}`);
    const subs = subData.subClientProperties ?? [];
    if (subs.length === 0) return null;

    if (subclientName) {
      const sub = subs.find((s: any) => (s.subClientEntity?.subclientName ?? '').toLowerCase() === subclientName.toLowerCase());
      return sub?.subClientEntity?.subclientId ?? null;
    }

    // Default: first subclient
    return subs[0]?.subClientEntity?.subclientId ?? null;
  }

  // ── Proactive Monitoring (called by scheduler in alfred.ts) ──

  async pollAndReport(): Promise<{ failed: number; storageWarnings: string[]; slaViolations: string[]; retriedJobs: number[] }> {
    const result = { failed: 0, storageWarnings: [] as string[], slaViolations: [] as string[], retriedJobs: [] as number[] };

    try {
      // 1. Check failed jobs
      const jobsData = await this.api<any>('GET', '/Job?completedJobLookupTime=1800&jobFilter=Backup');
      const jobs = jobsData.jobs ?? jobsData.jobList ?? [];
      const failed = jobs.filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Failed');
      result.failed = failed.length;

      // Auto-retry failed jobs
      if (this.config.auto_retry_failed && failed.length > 0) {
        for (const j of failed.slice(0, 3)) {
          const s = j.jobSummary ?? j;
          const subclientId = s.subclient?.subclientId;
          if (subclientId) {
            try {
              await this.api('POST', `/Subclient/${subclientId}/action/backup`, { backupLevel: s.backupLevel ?? 2 });
              result.retriedJobs.push(s.jobId);
            } catch { /* retry failed — non-fatal */ }
          }
        }
      }

      // 2. Storage warnings (V4 first, legacy fallback)
      let storagePoolsP: any[] = []; let isV4P = false;
      try { const d = await this.api<any>('GET', '/V4/Storage/Disk'); storagePoolsP = d.diskStorage ?? []; isV4P = storagePoolsP.length > 0; } catch { /* V4 N/A */ }
      if (!isV4P) try { const d = await this.api<any>('GET', '/StoragePool'); storagePoolsP = d.storagePoolList ?? []; } catch { /* skip */ }
      const warnPct = this.config.storage_warning_pct ?? 85;
      for (const p of storagePoolsP) {
        const totalMB = isV4P ? (p.capacity ?? 0) : ((p.totalCapacity ?? 0) / 1024 / 1024);
        const freeMB = isV4P ? (p.freeSpace ?? 0) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024);
        const usedPct = totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;
        if (usedPct >= warnPct) {
          const name = isV4P ? (p.name ?? '?') : (p.storagePoolEntity?.storagePoolName ?? p.storagePoolName ?? '?');
          result.storageWarnings.push(`${name}: ${usedPct}%`);
        }
      }

      // 3. SLA violations
      const rpoHours = this.config.sla_rpo_hours ?? 24;
      const allJobsData = await this.api<any>('GET', `/Job?completedJobLookupTime=${rpoHours * 3600}&jobFilter=Backup`);
      const allJobs = allJobsData.jobs ?? allJobsData.jobList ?? [];
      const clientLastSuccess = new Map<string, number>();
      for (const j of allJobs) {
        const s = j.jobSummary ?? j;
        if (s.status !== 'Completed') continue;
        const client = s.subclient?.clientName ?? '';
        const endTime = (s.endTime ?? 0) * 1000;
        const prev = clientLastSuccess.get(client) ?? 0;
        if (endTime > prev) clientLastSuccess.set(client, endTime);
      }
      const deadline = Date.now() - rpoHours * 60 * 60_000;
      for (const [client, last] of clientLastSuccess) {
        if (last < deadline) result.slaViolations.push(client);
      }

      // 4. Auto-incident
      if (this.config.auto_incident && this.itsmCallback && (result.failed > 0 || result.storageWarnings.length > 0)) {
        const title = result.failed > 0
          ? `Commvault: ${result.failed} fehlgeschlagene Backup-Jobs`
          : `Commvault: Storage-Warnung (${result.storageWarnings.join(', ')})`;
        try {
          await this.itsmCallback({
            action: 'create_incident',
            title,
            description: `Failed: ${result.failed}, Storage: ${result.storageWarnings.join(', ')}, SLA: ${result.slaViolations.join(', ')}`,
            priority: result.failed > 5 ? 'critical' : 'high',
            category: 'backup',
          });
        } catch { /* non-fatal */ }
      }
    } catch { /* polling failed — will retry next interval */ }

    return result;
  }

  /** Build compact context for reasoning engine. */
  async buildReasoningContext(): Promise<string> {
    try {
      const [jobsData, storageData] = await Promise.all([
        this.api<any>('GET', '/Job?completedJobLookupTime=86400&jobFilter=Backup').catch(() => ({ jobs: [] })),
        this.api<any>('GET', '/V4/Storage/Disk').catch(() =>
          this.api<any>('GET', '/StoragePool').catch(() => ({}))
        ),
      ]);

      const jobs = jobsData.jobs ?? jobsData.jobList ?? [];
      const failed = jobs.filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Failed');
      const running = jobs.filter((j: any) => (j.jobSummary?.status ?? j.status) === 'Running');

      const isV4 = !!storageData.diskStorage;
      const pools = storageData.diskStorage ?? storageData.storagePoolList ?? [];
      const warnPct = this.config.storage_warning_pct ?? 85;
      const warnings = pools.filter((p: any) => {
        const totalMB = isV4 ? (p.capacity ?? 0) : ((p.totalCapacity ?? 0) / 1024 / 1024);
        const freeMB = isV4 ? (p.freeSpace ?? 0) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024);
        return totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) >= warnPct : false;
      });

      const parts: string[] = [];
      if (failed.length > 0) parts.push(`${failed.length} fehlgeschlagene Backup-Jobs (24h)`);
      if (running.length > 0) parts.push(`${running.length} laufende Jobs`);
      if (warnings.length > 0) parts.push(`${warnings.length} Storage-Pool(s) über ${warnPct}%`);
      if (parts.length === 0) parts.push('Alle Backups OK');

      return parts.join(' | ');
    } catch {
      return '(Commvault nicht erreichbar)';
    }
  }
}
