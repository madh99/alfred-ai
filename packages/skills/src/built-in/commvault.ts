import type { SkillMetadata, SkillContext, SkillResult, CommvaultConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import {
  CommvaultStorage,
  CommvaultJobs,
  CommvaultPlans,
  CommvaultClients,
  CommvaultMediaAgents,
  CommvaultAlerts,
  CommvaultCommcell,
} from './commvault/index.js';
import type { CommvaultApiClient } from './commvault/types.js';

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

// ── All 60 actions ──
type Action =
  // Monitoring
  | 'status' | 'report' | 'analyze' | 'anomalies'
  // Jobs (7)
  | 'jobs' | 'job_detail' | 'job_history' | 'start_job' | 'stop_job' | 'retry_job' | 'browse_data'
  // Storage (12)
  | 'storage' | 'storage_detail' | 'storage_create_disk' | 'storage_create_cloud'
  | 'storage_create_local' | 'storage_delete' | 'storage_tape' | 'storage_tape_detail'
  | 'storage_ddb' | 'storage_arrays' | 'storage_backup_locations' | 'storage_mount_content'
  // Plans (8)
  | 'plans' | 'plan_ids' | 'plan_detail' | 'plan_create_server' | 'plan_create_laptop'
  | 'plan_delete' | 'plan_rules' | 'plan_rule_entities'
  // Clients (8)
  | 'clients' | 'client_detail' | 'servers' | 'file_servers' | 'server_groups'
  | 'subclients' | 'retire_server' | 'virtual_machines'
  // Media Agents (4)
  | 'media_agents' | 'media_agent_detail' | 'media_agents_ddb' | 'install_media_agent'
  // Alerts (8)
  | 'alerts' | 'alert_detail' | 'read_alert' | 'pin_alert' | 'delete_alerts'
  | 'alert_note' | 'alert_rules' | 'alert_types'
  // Commcell (11)
  | 'commcell_status' | 'commcell_enable' | 'commcell_disable' | 'global_settings'
  | 'license' | 'schedules' | 'schedule_policies' | 'replication_groups'
  | 'replication_status' | 'failover' | 'recovery_targets'
  // Legacy
  | 'restore' | 'modify_schedule' | 'configure';

const WRITE_ACTIONS = new Set<Action>([
  'start_job', 'stop_job', 'retry_job', 'restore', 'modify_schedule',
  'storage_create_disk', 'storage_create_cloud', 'storage_create_local', 'storage_delete',
  'plan_create_server', 'plan_create_laptop', 'plan_delete',
  'retire_server', 'install_media_agent',
  'delete_alerts',
  'commcell_enable', 'commcell_disable', 'failover',
]);

export class CommvaultSkill extends Skill implements CommvaultApiClient {
  readonly metadata: SkillMetadata = {
    name: 'commvault',
    category: 'infrastructure',
    description:
      'Commvault Backup Management — CommServe REST API v2/v4. ' +
      'Monitoring: status, report, analyze, anomalies. ' +
      'Jobs: jobs, job_detail, job_history, start_job, stop_job, retry_job, browse_data. ' +
      'Storage: storage, storage_detail, storage_create_disk/cloud/local, storage_delete, ' +
      'storage_tape, storage_tape_detail, storage_ddb, storage_arrays, storage_backup_locations, storage_mount_content. ' +
      'Plans: plans, plan_ids, plan_detail, plan_create_server/laptop, plan_delete, plan_rules, plan_rule_entities. ' +
      'Clients: clients, client_detail, servers, file_servers, server_groups, subclients, retire_server, virtual_machines. ' +
      'Media Agents: media_agents, media_agent_detail, media_agents_ddb, install_media_agent. ' +
      'Alerts: alerts, alert_detail, read_alert, pin_alert, delete_alerts, alert_note, alert_rules, alert_types. ' +
      'Commcell: commcell_status, commcell_enable/disable, global_settings, license, schedules, schedule_policies, ' +
      'replication_groups, replication_status, failover, recovery_targets. ' +
      'Legacy: restore, modify_schedule, configure.',
    riskLevel: 'admin',
    version: '2.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            // Monitoring
            'status', 'report', 'analyze', 'anomalies',
            // Jobs
            'jobs', 'job_detail', 'job_history', 'start_job', 'stop_job', 'retry_job', 'browse_data',
            // Storage
            'storage', 'storage_detail', 'storage_create_disk', 'storage_create_cloud',
            'storage_create_local', 'storage_delete', 'storage_tape', 'storage_tape_detail',
            'storage_ddb', 'storage_arrays', 'storage_backup_locations', 'storage_mount_content',
            // Plans
            'plans', 'plan_ids', 'plan_detail', 'plan_create_server', 'plan_create_laptop',
            'plan_delete', 'plan_rules', 'plan_rule_entities',
            // Clients
            'clients', 'client_detail', 'servers', 'file_servers', 'server_groups',
            'subclients', 'retire_server', 'virtual_machines',
            // Media Agents
            'media_agents', 'media_agent_detail', 'media_agents_ddb', 'install_media_agent',
            // Alerts
            'alerts', 'alert_detail', 'read_alert', 'pin_alert', 'delete_alerts',
            'alert_note', 'alert_rules', 'alert_types',
            // Commcell
            'commcell_status', 'commcell_enable', 'commcell_disable', 'global_settings',
            'license', 'schedules', 'schedule_policies', 'replication_groups',
            'replication_status', 'failover', 'recovery_targets',
            // Legacy
            'restore', 'modify_schedule', 'configure',
          ],
        },
        // Job params
        job_id: { type: 'number', description: 'Job ID (job_detail, stop_job, retry_job, browse_data)' },
        subclient_id: { type: 'number', description: 'Subclient ID (start_job, retry_job)' },
        client: { type: 'string', description: 'Client-Name (restore, legacy)' },
        client_id: { type: 'number', description: 'Client ID (client_detail, subclients)' },
        subclient: { type: 'string', description: 'Subclient-Name (legacy start_job)' },
        status: { type: 'string', description: 'Job-Status Filter: failed, running, completed, all' },
        hours: { type: 'number', description: 'Zeitraum in Stunden (default 24)' },
        days: { type: 'number', description: 'Zeitraum in Tagen (job_history, default 7)' },
        level: { type: 'string', description: 'Backup-Level: full, incremental, differential' },
        // Storage params
        pool_id: { type: 'number', description: 'Storage Pool ID (storage_detail, storage_delete, storage_backup_locations)' },
        storage_type: { type: 'string', description: 'Storage-Typ: Disk, Cloud, Local, HyperScale, Tape' },
        location_id: { type: 'number', description: 'Backup Location ID (storage_backup_locations)' },
        library_id: { type: 'number', description: 'Tape Library ID (storage_tape_detail)' },
        name: { type: 'string', description: 'Name (storage_create_*, plan_create_*)' },
        path: { type: 'string', description: 'Mount-Pfad (storage_create_disk/local)' },
        mediaAgent: { type: 'string', description: 'Media Agent Name (storage_create_*)' },
        deduplication: { type: 'boolean', description: 'Deduplizierung aktivieren (storage_create_disk)' },
        cloudType: { type: 'string', description: 'Cloud-Typ (storage_create_cloud)' },
        serviceHost: { type: 'string', description: 'Cloud Service Host' },
        container: { type: 'string', description: 'Cloud Container/Bucket' },
        mountPathId: { type: 'number', description: 'Mount Path ID (storage_mount_content)' },
        libraryId: { type: 'number', description: 'Library ID (storage_mount_content)' },
        mediaAgentId: { type: 'number', description: 'Media Agent ID (storage_mount_content)' },
        // Plan params
        plan_id: { type: 'number', description: 'Plan ID (plan_detail, plan_delete)' },
        planName: { type: 'string', description: 'Plan-Name (plan_create_server/laptop)' },
        // Client params
        server_id: { type: 'number', description: 'Server ID (retire_server)' },
        // Media Agent params
        media_agent_id: { type: 'number', description: 'Media Agent ID (media_agent_detail)' },
        hostNames: { type: 'array', items: { type: 'string' }, description: 'Hostnamen fuer MA-Installation' },
        username: { type: 'string', description: 'Username (install_media_agent)' },
        password: { type: 'string', description: 'Password (install_media_agent)' },
        os_type: { type: 'string', description: 'OS-Typ: WINDOWS, UNIX (install_media_agent)' },
        // Alert params
        alert_id: { type: 'number', description: 'Alert ID (alert_detail, read_alert, pin_alert, alert_note)' },
        alert_ids: { type: 'array', items: { type: 'number' }, description: 'Alert IDs (delete_alerts)' },
        severity: { type: 'string', description: 'Severity Filter: critical, major, information' },
        notes: { type: 'string', description: 'Notiz-Text (alert_note)' },
        unread: { type: 'boolean', description: 'Als ungelesen markieren (read_alert)' },
        unpin: { type: 'boolean', description: 'Alert entpinnen (pin_alert)' },
        enable_id: { type: 'number', description: 'Alert-Regel ID zum Aktivieren (alert_rules)' },
        disable_id: { type: 'number', description: 'Alert-Regel ID zum Deaktivieren (alert_rules)' },
        // Commcell params
        operation: { type: 'string', description: 'Commcell-Operation: Backup, Restore, Scheduler, DataAging, DDB, etc.' },
        group_id: { type: 'number', description: 'Failover Group ID' },
        operation_type: { type: 'string', description: 'Failover-Typ: Planned Failover, Unplanned Failover, etc.' },
        // Report/Analyze
        period: { type: 'string', description: 'Report-Zeitraum: day, week, month' },
        focus: { type: 'string', description: 'Analyse-Fokus: failures, storage, schedules, all' },
        // Restore
        point_in_time: { type: 'string', description: 'Restore Zeitpunkt (ISO)' },
        destination: { type: 'string', description: 'Restore Ziel-Client' },
        overwrite: { type: 'boolean', description: 'Restore: bestehende Daten ueberschreiben' },
        // Schedule
        schedule_name: { type: 'string', description: 'Schedule-Name (modify_schedule)' },
        frequency: { type: 'string', description: 'Neue Frequenz (modify_schedule)' },
        filter: { type: 'string', description: 'Name-Filter Pattern' },
        // Configure
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

  // ── Sub-modules ──
  private storage: CommvaultStorage;
  private jobs: CommvaultJobs;
  private plans: CommvaultPlans;
  private clients: CommvaultClients;
  private mediaAgents: CommvaultMediaAgents;
  private alerts: CommvaultAlerts;
  private commcell: CommvaultCommcell;

  constructor(config: CommvaultConfig) {
    super();
    this.config = { ...config };
    this.storage = new CommvaultStorage(this);
    this.jobs = new CommvaultJobs(this);
    this.plans = new CommvaultPlans(this);
    this.clients = new CommvaultClients(this);
    this.mediaAgents = new CommvaultMediaAgents(this);
    this.alerts = new CommvaultAlerts(this);
    this.commcell = new CommvaultCommcell(this);
  }

  // ── CommvaultApiClient interface ──
  async get<T = any>(path: string): Promise<T> { return this.api('GET', path); }
  async post<T = any>(path: string, body?: Record<string, unknown>): Promise<T> { return this.api('POST', path, body); }
  async put<T = any>(path: string, body?: Record<string, unknown>): Promise<T> { return this.api('PUT', path, body); }
  async delete<T = any>(path: string): Promise<T> { return this.api('DELETE', path); }

  setItsmCallback(cb: SkillCallback): void { this.itsmCallback = cb; }

  // ── Execute: route to module ──

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;

    // Write actions: check confirmation_mode
    if (WRITE_ACTIONS.has(action) && this.config.confirmation_mode) {
      return {
        success: true,
        data: { requiresConfirmation: true, action, input },
        display: `⚠️ **Bestätigung erforderlich** — ${action} ist im Bestätigungsmodus. Bitte bestätige die Aktion.`,
      };
    }

    switch (action) {
      // ── Monitoring ──
      case 'status':     return this.getStatus();
      case 'report':     return this.getReport(input);
      case 'analyze':    return this.getAnalyze(input);
      case 'anomalies':  return this.commcell.anomalies();

      // ── Jobs ──
      case 'jobs':        return this.jobs.list(input);
      case 'job_detail':  return this.jobs.detail(input);
      case 'job_history': return this.jobs.history(input);
      case 'start_job':   return this.jobs.start(input);
      case 'stop_job':    return this.jobs.stop(input);
      case 'retry_job':   return this.jobs.retry(input);
      case 'browse_data': return this.jobs.browse(input);

      // ── Storage ──
      case 'storage':                return this.storage.list();
      case 'storage_detail':         return this.storage.detail(input);
      case 'storage_create_disk':    return this.storage.createDisk(input);
      case 'storage_create_cloud':   return this.storage.createCloud(input);
      case 'storage_create_local':   return this.storage.createLocal(input);
      case 'storage_delete':         return this.storage.delete(input);
      case 'storage_tape':           return this.storage.tape(input);
      case 'storage_tape_detail':    return this.storage.tapeDetail(input);
      case 'storage_ddb':            return this.storage.ddb();
      case 'storage_arrays':         return this.storage.arrays();
      case 'storage_backup_locations': return this.storage.backupLocations(input);
      case 'storage_mount_content':  return this.storage.mountContent(input);

      // ── Plans ──
      case 'plans':              return this.plans.list();
      case 'plan_ids':           return this.plans.ids();
      case 'plan_detail':        return this.plans.detail(input);
      case 'plan_create_server': return this.plans.createServer(input);
      case 'plan_create_laptop': return this.plans.createLaptop(input);
      case 'plan_delete':        return this.plans.delete(input);
      case 'plan_rules':         return this.plans.rules();
      case 'plan_rule_entities': return this.plans.ruleEntities(input);

      // ── Clients ──
      case 'clients':          return this.clients.list();
      case 'client_detail':    return this.clients.detail(input);
      case 'servers':          return this.clients.servers();
      case 'file_servers':     return this.clients.fileServers();
      case 'server_groups':    return this.clients.serverGroups();
      case 'subclients':       return this.clients.subclients(input);
      case 'retire_server':    return this.clients.retire(input);
      case 'virtual_machines': return this.clients.virtualMachines();

      // ── Media Agents ──
      case 'media_agents':        return this.mediaAgents.list();
      case 'media_agent_detail':  return this.mediaAgents.detail(input);
      case 'media_agents_ddb':    return this.mediaAgents.ddb();
      case 'install_media_agent': return this.mediaAgents.install(input);

      // ── Alerts ──
      case 'alerts':        return this.alerts.list(input);
      case 'alert_detail':  return this.alerts.detail(input);
      case 'read_alert':    return this.alerts.read(input);
      case 'pin_alert':     return this.alerts.pin(input);
      case 'delete_alerts': return this.alerts.delete(input);
      case 'alert_note':    return this.alerts.addNote(input);
      case 'alert_rules':   return this.alerts.rules(input);
      case 'alert_types':   return this.alerts.types();

      // ── Commcell ──
      case 'commcell_status':      return this.commcell.status();
      case 'commcell_enable':      return this.commcell.enable(input);
      case 'commcell_disable':     return this.commcell.disable(input);
      case 'global_settings':      return this.commcell.globalSettings();
      case 'license':              return this.commcell.license();
      case 'schedules':            return this.commcell.schedules();
      case 'schedule_policies':    return this.commcell.schedulePolicies();
      case 'replication_groups':   return this.commcell.replicationGroups();
      case 'replication_status':   return this.commcell.replicationStatus();
      case 'failover':             return this.commcell.failover(input);
      case 'recovery_targets':     return this.commcell.recoveryTargets();

      // ── Legacy ──
      case 'restore':          return this.handleRestore(input);
      case 'modify_schedule':  return this.handleModifySchedule(input);
      case 'configure':        return this.handleConfigure(input);

      default:
        return { success: false, error: `Unknown action "${action}"` };
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

  // ── Monitoring Actions (use modules internally) ────────────

  private async getStatus(): Promise<SkillResult> {
    const [jobsResult, alertsResult, storageResult] = await Promise.allSettled([
      this.jobs.list({ hours: 24, status: undefined }),
      this.alerts.list({}),
      this.storage.list(),
    ]);

    // Extract data from module results
    const jobsData = jobsResult.status === 'fulfilled' ? jobsResult.value.data : null;
    const alertsData = alertsResult.status === 'fulfilled' ? alertsResult.value.data : null;
    const storageData = storageResult.status === 'fulfilled' ? storageResult.value.data : null;

    // Count failed/running from raw jobs data
    const allJobs: any[] = jobsData?.jobs ?? [];
    const failed = allJobs.filter((j: any) => {
      const s = (j.status ?? '').toLowerCase();
      return s.includes('failed') || s.includes('killed');
    });
    const running = allJobs.filter((j: any) => {
      const s = (j.status ?? '').toLowerCase();
      return s.includes('running') || s.includes('active');
    });
    const completed = allJobs.filter((j: any) => {
      const s = (j.status ?? '').toLowerCase();
      return s.includes('completed') && !s.includes('error') && !s.includes('warning');
    });

    const totalAlerts = alertsData?.totalCount ?? 0;
    const unreadAlerts = alertsData?.unreadCount ?? 0;
    const criticalAlerts = (alertsData?.alerts ?? []).filter(
      (a: any) => a.severity === 'CRITICAL',
    ).length;

    const storagePools = storageData?.total ?? 0;

    return {
      success: true,
      data: {
        failed: failed.length,
        running: running.length,
        completed: completed.length,
        alerts: criticalAlerts,
        totalAlerts,
        storagePools,
      },
      display: [
        '## Commvault Status',
        '',
        `**Jobs (24h):** ${completed.length} erfolgreich, ${running.length} laufend, ${failed.length} fehlgeschlagen`,
        `**Alerts:** ${criticalAlerts} kritisch, ${totalAlerts} gesamt (${unreadAlerts} ungelesen)`,
        `**Storage Pools:** ${storagePools}`,
        '',
        storageResult.status === 'fulfilled' && storageResult.value.display
          ? storageResult.value.display
          : '',
      ].filter(Boolean).join('\n'),
    };
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

    // SLA check
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

    const totalSizeTB = jobs.reduce((sum: number, j: any) =>
      sum + ((j.jobSummary?.sizeOfApplication ?? j.sizeOfApplication ?? 0) / 1024 / 1024 / 1024 / 1024), 0);

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

  private async getAnalyze(input: Record<string, unknown>): Promise<SkillResult> {
    const focus = (input.focus as string) ?? 'all';
    const parts: string[] = [];

    if (focus === 'all' || focus === 'failures') {
      const jobsData = await this.api<any>('GET', '/Job?completedJobLookupTime=86400&jobFilter=Backup');
      const failed = (jobsData.jobs ?? jobsData.jobList ?? []).filter(
        (j: any) => (j.jobSummary?.status ?? j.status) === 'Failed',
      );
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
      try {
        const storageResult = await this.storage.list();
        if (storageResult.display) parts.push('STORAGE:', storageResult.display);
      } catch {
        parts.push('STORAGE: (nicht verfuegbar)');
      }
    }

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

  // ── Legacy Actions ─────────────────────────────────────────

  private async handleRestore(input: Record<string, unknown>): Promise<SkillResult> {
    const clientName = input.client as string;
    if (!clientName) return { success: false, error: 'Missing client name' };

    const subclientId = await this.resolveSubclientId(clientName, input.subclient as string | undefined);
    if (!subclientId) return { success: false, error: `Subclient für "${clientName}" nicht gefunden` };

    const restoreBody: Record<string, unknown> = {
      taskInfo: {
        task: { taskType: 1 },
        subTasks: [{
          subTask: { subTaskType: 3, operationType: 1001 },
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

  private async handleModifySchedule(input: Record<string, unknown>): Promise<SkillResult> {
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

  private async handleConfigure(input: Record<string, unknown>): Promise<SkillResult> {
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

      // 2. Storage warnings
      try {
        const warnPct = this.config.storage_warning_pct ?? 85;
        let pools: any[] = []; let isV4P = false;
        try { const d = await this.api<any>('GET', '/V4/Storage/Disk'); pools = d.diskStorage ?? []; isV4P = pools.length > 0; } catch { /* V4 N/A */ }
        if (!isV4P) try { const d = await this.api<any>('GET', '/StoragePool'); pools = d.storagePoolList ?? []; } catch { /* skip */ }
        for (const p of pools) {
          const totalMB = isV4P ? (p.capacity ?? 0) : ((p.totalCapacity ?? 0) / 1024 / 1024);
          const freeMB = isV4P ? (p.freeSpace ?? 0) : ((p.totalFreeSpace ?? p.freeCapacity ?? 0) / 1024 / 1024);
          const usedPct = totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;
          if (usedPct >= warnPct) {
            const name = isV4P ? (p.name ?? '?') : (p.storagePoolEntity?.storagePoolName ?? p.storagePoolName ?? '?');
            result.storageWarnings.push(`${name}: ${usedPct}%`);
          }
        }
      } catch { /* storage check failed — non-fatal */ }

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
