import type { SkillMetadata, SkillContext, SkillResult, InfraDefaultsConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Action = 'deploy' | 'full_deploy' | 'provision' | 'status' | 'logs' | 'stop' | 'start' | 'restart' | 'rollback' | 'setup_node' | 'setup_python';
type SkillCallback = (input: Record<string, unknown>) => Promise<SkillResult>;

/** Sanitize user input for safe SSH command interpolation. */
function sanitize(val: string): string {
  return val.replace(/[;&|`$(){}!#\n\r]/g, '');
}
function validateHost(h: string): boolean { return /^[\w.\-:]+$/.test(h); }
function validateName(n: string): boolean { return /^[\w.\-]+$/.test(n); }
function validateBranch(b: string): boolean { return /^[\w.\-/]+$/.test(b); }
function validateUrl(u: string): boolean { return /^(https?:\/\/[\w.\-/:@]+|[\w.\-]+@[\w.\-]+:[\w.\-/]+)$/.test(u); }

/**
 * Deploy Skill — SSH-basiertes Deployment auf beliebigen Hosts.
 * Kein Host ist hardcoded — alles wird pro Aufruf angegeben oder aus Infra-Defaults genommen.
 */
export class DeploySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'deploy',
    category: 'infrastructure',
    description:
      'SSH-basiertes Deployment + VM-Provisionierung. ' +
      '"provision" erstellt eine neue VM/LXC aus Proxmox-Template, wartet auf SSH+Cloud-Init, installiert Runtime (node/python/docker), qemu-guest-agent, Docker-Gruppe. IMMER provision statt proxmox clone_vm verwenden wenn eine VM erstellt UND konfiguriert werden soll! Braucht: hostname, template (VMID), target (new_vm/new_lxc), runtime (docker/node/python). Optional: ip, gateway, memory, cores. ' +
      '"full_deploy" = provision + Code-Deployment + optional DNS/Proxy/Firewall. Braucht project + repo_url. ' +
      '"deploy" klont/pullt ein Git-Repo auf bestehendem Host, installiert Dependencies, baut und startet den Service. ' +
      '"status" zeigt den Service-Status (pm2/systemd). ' +
      '"logs" zeigt die letzten Log-Zeilen. ' +
      '"stop/start/restart" verwalten den Service. ' +
      '"rollback" setzt auf den vorherigen Commit zurück. ' +
      '"setup_node" installiert Node.js auf dem Zielhost. ' +
      '"setup_python" installiert Python + venv auf dem Zielhost. ' +
      'Template-Erkennung: ubuntu→User ubuntu, rocky/alma/centos→User cloud-user. SSH-Key wird automatisch injiziert.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 300_000, // 5 min for deploy
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['deploy', 'full_deploy', 'provision', 'status', 'logs', 'stop', 'start', 'restart', 'rollback', 'setup_node', 'setup_python'] },
        host: { type: 'string', description: 'Ziel-IP oder Hostname (für deploy/status/logs etc. erforderlich, für full_deploy optional wenn target=new_lxc/new_vm)' },
        target: { type: 'string', description: 'Deployment-Ziel für full_deploy: existing (bestehendem Host), new_lxc (neue LXC erstellen), new_vm (VM aus Template klonen). Default: existing' },
        domain: { type: 'string', description: 'Domain für DNS + Reverse Proxy (für full_deploy, z.B. uboot.cc)' },
        public_ip: { type: 'string', description: 'Öffentliche IP für DNS A-Record (für full_deploy)' },
        network_name: { type: 'string', description: 'VLAN/Netzwerk-Name für IP-Vergabe bei new_lxc/new_vm (z.B. Default, Keller)' },
        template: { type: 'string', description: 'Proxmox Template für new_lxc/new_vm (z.B. ubuntu-22.04, rocky-9, debian-12 für LXC; VMID 9000/9001 für VM). Cloud-Init User wird automatisch erkannt (ubuntu/rocky→cloud-user/debian/fedora)' },
        hostname: { type: 'string', description: 'Hostname für neue VM/LXC' },
        memory: { type: 'number', description: 'RAM in MB für neue VM/LXC (default: 2048)' },
        cores: { type: 'number', description: 'CPU Cores für neue VM/LXC (default: 2)' },
        skip_dns: { type: 'boolean', description: 'DNS-Schritt überspringen (default: false)' },
        skip_proxy: { type: 'boolean', description: 'Reverse-Proxy-Schritt überspringen (default: false)' },
        skip_firewall: { type: 'boolean', description: 'Firewall-Schritt überspringen (default: false)' },
        npm_target: { type: 'string', description: 'IP des Nginx Proxy Manager Hosts (für Firewall-Regel NPM→App)' },
        user: { type: 'string', description: 'SSH User (default: aus infra config)' },
        project: { type: 'string', description: 'Projektname (= Verzeichnisname + pm2/systemd Service-Name)' },
        repo_url: { type: 'string', description: 'Git-Repo URL zum Klonen (bei erstem Deploy)' },
        branch: { type: 'string', description: 'Git Branch (NICHT angeben wenn unklar — wird automatisch erkannt per git ls-remote)' },
        app_port: { type: 'number', description: 'Port auf dem die App läuft' },
        process_manager: { type: 'string', description: 'pm2, systemd oder docker-compose (default: aus infra config)' },
        runtime: { type: 'string', description: 'node, python oder static (default: aus infra config)' },
        build_command: { type: 'string', description: 'Custom Build-Befehl (default: npm run build)' },
        install_command: { type: 'string', description: 'Custom Install-Befehl (default: npm install)' },
        start_command: { type: 'string', description: 'Custom Start-Befehl (default: npm start)' },
        lines: { type: 'number', description: 'Anzahl Log-Zeilen für "logs" Action (default: 50)' },
        gateway: { type: 'string', description: 'Gateway-IP für neue VMs/LXCs (default: x.x.x.1)' },
        subnet_prefix: { type: 'string', description: 'Subnet-Präfix für neue VMs/LXCs (default: 24)' },
      },
      required: ['action'],
    },
  };

  private readonly defaults: InfraDefaultsConfig;

  // Orchestrator callbacks — injected from alfred.ts
  private proxmoxFn?: SkillCallback;
  private cloudflareFn?: SkillCallback;
  private npmFn?: SkillCallback;
  private firewallFn?: SkillCallback;
  private unifiFn?: SkillCallback;
  private cmdbCallback?: (result: Record<string, unknown>) => Promise<void>;
  private postDeployCallback?: (host: string, project: string, userId: string) => Promise<void>;
  private forgeConfig?: { github?: { token?: string }; gitlab?: { token?: string; baseUrl?: string } };

  setOrchestrationCallbacks(cbs: {
    proxmox?: SkillCallback;
    cloudflare?: SkillCallback;
    npm?: SkillCallback;
    firewall?: SkillCallback;
    unifi?: SkillCallback;
  }): void {
    this.proxmoxFn = cbs.proxmox;
    this.cloudflareFn = cbs.cloudflare;
    this.npmFn = cbs.npm;
    this.firewallFn = cbs.firewall;
    this.unifiFn = cbs.unifi;
  }

  setCmdbCallback(cb: (result: Record<string, unknown>) => Promise<void>): void {
    this.cmdbCallback = cb;
  }

  /** Post-deploy: CMDB discovery + Deep Scan + Service creation (fire-and-forget). */
  setPostDeployCallback(cb: (host: string, project: string, userId: string) => Promise<void>): void {
    this.postDeployCallback = cb;
  }

  /** Set forge config for auto-injecting Git tokens into repo URLs. */
  setForgeConfig(config: { github?: { token?: string }; gitlab?: { token?: string; baseUrl?: string } }): void {
    this.forgeConfig = config;
  }

  constructor(defaults?: InfraDefaultsConfig) {
    super();
    this.defaults = defaults ?? {};
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;

    if (action === 'full_deploy') return this.fullDeploy(input);
    if (action === 'provision') return this.provision(input);

    const host = input.host as string;
    if (!host) return { success: false, error: 'host ist erforderlich' };
    if (!validateHost(host)) return { success: false, error: 'Ungültiger Host (nur Buchstaben, Zahlen, Punkte, Bindestriche)' };

    const user = (input.user as string) ?? this.defaults.sshUser ?? 'root';
    const project = input.project as string | undefined;
    const pm = (input.process_manager as string) ?? this.defaults.processManager ?? 'pm2';
    const runtime = (input.runtime as string) ?? this.defaults.runtime ?? 'node';

    switch (action) {
      case 'deploy': return this.doDeploy(host, user, input, pm, runtime);
      case 'status': return this.doStatus(host, user, project, pm);
      case 'logs': return this.doLogs(host, user, project, pm, input.lines as number | undefined);
      case 'stop': return this.doServiceAction(host, user, project!, pm, 'stop');
      case 'start': return this.doServiceAction(host, user, project!, pm, 'start');
      case 'restart': return this.doServiceAction(host, user, project!, pm, 'restart');
      case 'rollback': return this.doRollback(host, user, project!, runtime);
      case 'setup_node': return this.doSetupNode(host, user);
      case 'setup_python': return this.doSetupPython(host, user);
      default: return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }

  /** Run a command on the remote host via SSH. */
  private async ssh(host: string, user: string, command: string): Promise<string> {
    const keyPath = this.defaults.sshKeyPath ?? `${process.env['HOME'] ?? '/root'}/.ssh/id_ed25519`;
    const { stdout, stderr } = await execFileAsync('ssh', [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=10',
      `${user}@${host}`,
      command,
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 300_000 });
    if (stderr && !stdout) return stderr.trim();
    return stdout.trim();
  }

  /** Test SSH connectivity. */
  private async testSsh(host: string, user: string): Promise<boolean> {
    try {
      await this.ssh(host, user, 'echo ok');
      return true;
    } catch { return false; }
  }

  /** Inject forge token into Git URL if no auth is present. */
  private injectGitToken(url: string): string {
    if (!this.forgeConfig || !url.startsWith('http')) return url;
    if (/^https?:\/\/[^@/]+@/.test(url)) return url; // already has auth
    try {
      const urlObj = new URL(url);
      const token = this.forgeConfig.gitlab?.token ?? this.forgeConfig.github?.token;
      if (token) {
        urlObj.username = 'oauth2';
        urlObj.password = token;
        return urlObj.toString();
      }
    } catch { /* not a valid URL */ }
    return url;
  }

  private async doDeploy(host: string, user: string, input: Record<string, unknown>, pm: string, runtime: string): Promise<SkillResult> {
    const project = sanitize(input.project as string ?? '');
    const rawRepoUrl = input.repo_url ? sanitize(input.repo_url as string) : undefined;
    const repoUrl = rawRepoUrl ? this.injectGitToken(rawRepoUrl) : undefined;
    let branch = input.branch ? sanitize(input.branch as string) : '';
    const appPort = input.app_port as number | undefined;
    if (!project || !validateName(project)) return { success: false, error: 'project erforderlich (nur Buchstaben, Zahlen, Bindestriche, Punkte)' };
    if (repoUrl && !validateUrl(repoUrl)) return { success: false, error: 'Ungültige repo_url' };
    if (branch && !validateBranch(branch)) return { success: false, error: 'Ungültiger Branch-Name' };
    if (appPort !== undefined && (appPort < 1 || appPort > 65535)) return { success: false, error: 'app_port muss zwischen 1-65535 sein' };

    // 1. Test SSH
    const sshOk = await this.testSsh(host, user);
    if (!sshOk) return { success: false, error: `SSH zu ${user}@${host} fehlgeschlagen. Prüfe Verbindung und SSH Key.` };

    const projectDir = `/home/${user}/${project}`;
    const steps: string[] = [];

    // 2. Clone or pull
    try {
      const dirExists = await this.ssh(host, user, `test -d ${projectDir}/.git && echo yes || echo no`);
      if (dirExists === 'no' && repoUrl) {
        // Auto-detect default branch if not specified
        if (!branch) {
          try {
            const refs = await this.ssh(host, user, `git ls-remote --symref ${repoUrl} HEAD 2>/dev/null | head -1`);
            const match = refs.match(/refs\/heads\/(\S+)/);
            branch = match?.[1] ?? 'main';
          } catch { branch = 'main'; }
        }
        await this.ssh(host, user, `git clone --branch ${branch} ${repoUrl} ${projectDir}`);
        steps.push(`📦 Geklont: ${repoUrl} (Branch: ${branch})`);
      } else if (dirExists === 'yes') {
        // Update remote URL if repo_url provided (ensures token-injected URL is used)
        if (repoUrl) {
          try { await this.ssh(host, user, `cd ${projectDir} && git remote set-url origin '${repoUrl}'`); } catch { /* keep existing */ }
        }
        if (!branch) {
          try {
            branch = (await this.ssh(host, user, `cd ${projectDir} && git rev-parse --abbrev-ref HEAD`)).trim() || 'main';
          } catch { branch = 'main'; }
        }
        await this.ssh(host, user, `cd ${projectDir} && git fetch origin && git checkout ${branch} && git pull origin ${branch}`);
        steps.push(`📥 Gepullt: ${branch}`);
      } else {
        return { success: false, error: `Projekt ${projectDir} existiert nicht und keine repo_url angegeben` };
      }
    } catch (err) {
      return { success: false, error: `Git-Operation fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 3. Install dependencies
    const installCmd = (input.install_command as string)
      ?? (runtime === 'node' ? 'npm install' : runtime === 'python' ? 'pip install -r requirements.txt' : '');
    if (installCmd) {
      try {
        await this.ssh(host, user, `cd ${projectDir} && ${installCmd}`);
        steps.push(`📦 Dependencies installiert`);
      } catch (err) {
        steps.push(`⚠️ Install-Warnung: ${err instanceof Error ? err.message.slice(0, 100) : ''}`);
      }
    }

    // 4. Build
    const buildCmd = (input.build_command as string)
      ?? (runtime === 'node' ? 'npm run build --if-present' : '');
    if (buildCmd) {
      try {
        await this.ssh(host, user, `cd ${projectDir} && ${buildCmd}`);
        steps.push(`🔨 Build erfolgreich`);
      } catch (err) {
        steps.push(`⚠️ Build-Warnung: ${err instanceof Error ? err.message.slice(0, 100) : ''}`);
      }
    }

    // 5. Start/Restart service
    const startCmd = (input.start_command as string) ?? (runtime === 'node' ? 'npm start' : runtime === 'python' ? 'python main.py' : '');
    try {
      if (pm === 'pm2') {
        const portEnv = appPort ? `PORT=${appPort} ` : '';
        // Try restart first, if not running → start
        try {
          await this.ssh(host, user, `cd ${projectDir} && pm2 restart ${project}`);
          steps.push(`🔄 pm2 restart: ${project}`);
        } catch {
          // pm2 start npm --name X -- start (correct format for npm start)
          if (startCmd === 'npm start') {
            await this.ssh(host, user, `cd ${projectDir} && ${portEnv}pm2 start npm --name ${project} -- start`);
          } else {
            await this.ssh(host, user, `cd ${projectDir} && ${portEnv}pm2 start ${startCmd} --name ${project}`);
          }
          steps.push(`🚀 pm2 start: ${project}${appPort ? ` (Port ${appPort})` : ''}`);
        }
        // Save pm2 config for auto-start
        try { await this.ssh(host, user, 'pm2 save'); } catch { /* best effort */ }
      } else if (pm === 'systemd') {
        await this.ssh(host, user, `sudo systemctl restart ${project}`);
        steps.push(`🔄 systemd restart: ${project}`);
      } else if (pm === 'docker-compose') {
        await this.ssh(host, user, `cd ${projectDir} && docker-compose up -d --build`);
        steps.push(`🐳 docker-compose up: ${project}`);
      }
    } catch (err) {
      return { success: false, error: `Service-Start fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, data: { steps } };
    }

    // 6. Verify
    let verifyOk = false;
    if (appPort) {
      try {
        await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3s for startup
        const result = await this.ssh(host, user, `curl -s -o /dev/null -w '%{http_code}' http://localhost:${appPort}/ || echo 000`);
        verifyOk = result.startsWith('2') || result.startsWith('3');
        steps.push(verifyOk ? `✅ Verify: HTTP ${result} auf Port ${appPort}` : `⚠️ Verify: HTTP ${result} auf Port ${appPort}`);
      } catch {
        steps.push(`⚠️ Verify fehlgeschlagen`);
      }
    }

    return {
      success: true,
      data: { host, project, port: appPort, steps, verified: verifyOk },
      display: `## Deploy: ${project} → ${host}\n\n${steps.join('\n')}`,
    };
  }

  private async doStatus(host: string, user: string, project: string | undefined, pm: string): Promise<SkillResult> {
    let output: string;
    if (pm === 'pm2') {
      output = project
        ? await this.ssh(host, user, `pm2 describe ${project} 2>/dev/null || echo 'Not found'`)
        : await this.ssh(host, user, 'pm2 list');
    } else if (pm === 'systemd') {
      output = await this.ssh(host, user, `systemctl status ${project ?? '*'} --no-pager -l`);
    } else {
      output = await this.ssh(host, user, `cd /home/${user}/${project ?? '.'} && docker-compose ps`);
    }
    return { success: true, display: `## Service Status: ${project ?? 'alle'} auf ${host}\n\n\`\`\`\n${output}\n\`\`\`` };
  }

  private async doLogs(host: string, user: string, project: string | undefined, pm: string, lines?: number): Promise<SkillResult> {
    const n = lines ?? 50;
    let output: string;
    if (pm === 'pm2') {
      output = await this.ssh(host, user, `pm2 logs ${project ?? 'all'} --lines ${n} --nostream 2>/dev/null || echo 'No logs'`);
    } else if (pm === 'systemd') {
      output = await this.ssh(host, user, `journalctl -u ${project} -n ${n} --no-pager`);
    } else {
      output = await this.ssh(host, user, `cd /home/${user}/${project ?? '.'} && docker-compose logs --tail ${n}`);
    }
    return { success: true, display: `## Logs: ${project ?? 'alle'} auf ${host}\n\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\`` };
  }

  private async doServiceAction(host: string, user: string, project: string, pm: string, action: 'stop' | 'start' | 'restart'): Promise<SkillResult> {
    if (!project) return { success: false, error: 'project erforderlich' };
    let output: string;
    if (pm === 'pm2') {
      output = await this.ssh(host, user, `pm2 ${action} ${project}`);
    } else if (pm === 'systemd') {
      output = await this.ssh(host, user, `sudo systemctl ${action} ${project}`);
    } else {
      const dcAction = action === 'stop' ? 'down' : action === 'start' ? 'up -d' : 'restart';
      output = await this.ssh(host, user, `cd /home/${user}/${project} && docker-compose ${dcAction}`);
    }
    return { success: true, display: `✅ ${action}: ${project} auf ${host}\n\n${output}` };
  }

  private async doRollback(host: string, user: string, project: string, runtime: string): Promise<SkillResult> {
    if (!project) return { success: false, error: 'project erforderlich' };
    const projectDir = `/home/${user}/${project}`;
    const steps: string[] = [];

    await this.ssh(host, user, `cd ${projectDir} && git revert --no-edit HEAD`);
    steps.push('⏪ Git: revert HEAD');

    if (runtime === 'node') {
      await this.ssh(host, user, `cd ${projectDir} && npm install && npm run build --if-present`);
      steps.push('📦 Rebuild');
    }

    try {
      await this.ssh(host, user, `pm2 restart ${project} 2>/dev/null || sudo systemctl restart ${project} 2>/dev/null`);
      steps.push('🔄 Service restarted');
    } catch { steps.push('⚠️ Service restart fehlgeschlagen'); }

    return { success: true, display: `## Rollback: ${project} auf ${host}\n\n${steps.join('\n')}` };
  }

  private async doSetupNode(host: string, user: string): Promise<SkillResult> {
    const script = `
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - &&
      sudo apt-get install -y nodejs &&
      sudo npm install -g pm2 &&
      pm2 startup systemd -u ${user} --hp /home/${user} || true &&
      node --version && npm --version && pm2 --version
    `.trim();
    const output = await this.ssh(host, user, script);
    return { success: true, display: `## Node.js Setup auf ${host}\n\n\`\`\`\n${output}\n\`\`\`` };
  }

  private async doSetupPython(host: string, user: string): Promise<SkillResult> {
    const script = `
      sudo apt-get update && sudo apt-get install -y python3 python3-pip python3-venv &&
      python3 --version && pip3 --version
    `.trim();
    const output = await this.ssh(host, user, script);
    return { success: true, display: `## Python Setup auf ${host}\n\n\`\`\`\n${output}\n\`\`\`` };
  }

  // ── Full Deploy Orchestrator ──────────────────────────────────

  /**
   * Provision: Create VM/LXC + install runtime. No code deployment.
   * Use for "erstelle eine VM mit Docker" without needing a project/repo.
   */
  private async provision(input: Record<string, unknown>): Promise<SkillResult> {
    // Re-use fullDeploy but skip code deployment
    const hostname = input.hostname as string;
    if (!hostname) return { success: false, error: 'hostname erforderlich' };
    // Set project=hostname so fullDeploy doesn't complain, but mark skip_deploy
    return this.fullDeploy({ ...input, project: hostname, _skip_deploy: true });
  }

  private async fullDeploy(input: Record<string, unknown>): Promise<SkillResult> {
    const project = input.project as string;
    const domain = input.domain as string | undefined;
    const target = (input.target as string) ?? 'existing';
    const runtime = (input.runtime as string) ?? this.defaults.runtime ?? 'node';
    const pm = (input.process_manager as string) ?? (runtime === 'docker' ? 'docker-compose' : this.defaults.processManager ?? 'pm2');
    let user = (input.user as string) ?? this.defaults.sshUser ?? 'madh';
    const appPort = input.app_port as number | undefined;
    const steps: string[] = [];

    if (!project) return { success: false, error: 'project erforderlich' };
    if (!validateName(project)) return { success: false, error: 'Ungültiger Projektname' };
    if (domain && !/^[\w.\-]+$/.test(domain)) return { success: false, error: 'Ungültige Domain' };

    let host = input.host as string | undefined;
    if (host && !validateHost(host)) return { success: false, error: 'Ungültiger Hostname' };

    try {
      // ── STEP 1: Determine/Create Host ──
      if (target === 'new_lxc' || target === 'new_vm') {
        // 1a. Get free IP (via UniFi if available)
        const networkName = (input.network_name as string) ?? this.defaults.network ?? 'Default';
        if (this.unifiFn && !host) {
          const ipResult = await this.unifiFn({ action: 'next_free_ip', network_name: networkName });
          if (ipResult.success && ipResult.data) {
            host = (ipResult.data as Record<string, unknown>).ip as string;
            steps.push(`🌐 IP zugewiesen: ${host} (${networkName})`);
          }
        }
        if (!host) return { success: false, error: 'Keine freie IP gefunden und kein host angegeben', data: { steps } };

        // 1b. Create VM/LXC on Proxmox
        if (this.proxmoxFn) {
          const template = input.template as string ?? (target === 'new_lxc' ? 'ubuntu-22.04' : '9000');
          const hostname = (input.hostname as string) ?? project;
          const memory = (input.memory as number) ?? 2048;
          const cores = (input.cores as number) ?? 2;

          // Detect Cloud-Init default user from template name
          const templateLower = template.toLowerCase();
          const cloudInitUser = input.user as string
            ?? (templateLower.includes('rocky') || templateLower.includes('alma') || templateLower.includes('centos') ? 'cloud-user'
              : templateLower.includes('debian') ? 'debian'
              : templateLower.includes('fedora') ? 'fedora'
              : target === 'new_lxc' ? 'root'  // LXC containers default to root
              : 'ubuntu');  // Ubuntu Cloud-Init default
          // Override user for SSH after creation
          user = cloudInitUser;
          steps.push(`👤 Cloud-Init User: ${cloudInitUser}`);

          // Read SSH public key
          let sshKey: string | undefined;
          const keyPath = this.defaults.sshKeyPath ?? `${process.env['HOME'] ?? '/root'}/.ssh/id_ed25519`;
          try {
            sshKey = readFileSync(`${keyPath}.pub`, 'utf-8').trim();
            steps.push(`🔑 SSH Key geladen (${keyPath}.pub, ${sshKey.length} Zeichen)`);
          } catch (err: any) {
            steps.push(`⚠️ SSH Key nicht lesbar: ${keyPath}.pub — ${err.message}`);
          }

          if (target === 'new_lxc') {
            const r = await this.proxmoxFn({
              action: 'create_lxc', template, hostname, memory, cores,
              ip: `${host}/${input.subnet_prefix ?? '24'}`, gateway: (input.gateway as string) ?? host.replace(/\.\d+$/, '.1'),
              ssh_public_key: sshKey,
            });
            if (!r.success) {
              steps.push(`❌ LXC-Erstellung fehlgeschlagen: ${r.error}`);
              return { success: false, error: 'LXC-Erstellung fehlgeschlagen', data: { steps } };
            }
            steps.push(`📦 LXC "${hostname}" erstellt (Template: ${template})`);
          } else {
            const r = await this.proxmoxFn({
              action: 'clone_vm', template, hostname, memory, cores,
              ip: `${host}/${input.subnet_prefix ?? '24'}`, gateway: (input.gateway as string) ?? host.replace(/\.\d+$/, '.1'),
              ssh_public_key: sshKey,
            });
            if (!r.success) {
              steps.push(`❌ VM-Erstellung fehlgeschlagen: ${r.error}`);
              return { success: false, error: 'VM-Erstellung fehlgeschlagen', data: { steps } };
            }
            steps.push(`📦 VM "${hostname}" geklont aus Template ${template}`);
          }

          // Wait for VM to be ready via SSH (Cloud-Init needs 60-120s)
          steps.push('⏳ Warte auf VM + Cloud-Init...');
          let sshReady = false;
          const sshStartTime = Date.now();
          const sshTimeout = 180_000; // 3 minutes max
          const sshInterval = 15_000; // check every 15s
          await new Promise(r => setTimeout(r, 20_000)); // initial wait for boot
          while (Date.now() - sshStartTime < sshTimeout) {
            sshReady = await this.testSsh(host!, user);
            if (sshReady) break;
            await new Promise(r => setTimeout(r, sshInterval));
          }
          if (!sshReady) {
            const waited = Math.round((Date.now() - sshStartTime) / 1000);
            steps.push(`❌ SSH nicht erreichbar nach ${waited}s`);
            return { success: false, error: `SSH zu ${user}@${host} nicht erreichbar nach ${waited}s — Cloud-Init ggf. nicht fertig`, data: { steps } };
          }
          const waited = Math.round((Date.now() - sshStartTime) / 1000);
          steps.push(`✅ Host ${host} erreichbar via SSH (User: ${user}, nach ${waited}s)`);

          // Detect OS family for package manager
          const isRhel = templateLower.includes('rocky') || templateLower.includes('alma') || templateLower.includes('centos') || templateLower.includes('fedora') || templateLower.includes('rhel');

          // Setup runtime if needed
          if (runtime === 'node') {
            if (isRhel) {
              await this.ssh(host, user, 'curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs && sudo npm install -g pm2 && sudo pm2 startup systemd -u $USER --hp $HOME').catch(() => {});
              steps.push('📦 Node.js + pm2 installiert (dnf)');
            } else {
              const setup = await this.doSetupNode(host, user);
              steps.push(setup.success ? '📦 Node.js + pm2 installiert' : `⚠️ Node-Setup: ${setup.display}`);
            }
          } else if (runtime === 'python') {
            if (isRhel) {
              await this.ssh(host, user, 'sudo dnf install -y python3 python3-pip').catch(() => {});
              steps.push('🐍 Python installiert (dnf)');
            } else {
              const setup = await this.doSetupPython(host, user);
              steps.push(setup.success ? '🐍 Python installiert' : `⚠️ Python-Setup: ${setup.display}`);
            }
          } else if (runtime === 'docker' || pm === 'docker-compose') {
            await this.ssh(host, user, 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER').catch(() => {});
            if (isRhel) {
              await this.ssh(host, user, 'sudo dnf install -y docker-compose-plugin').catch(() => {});
            } else {
              await this.ssh(host, user, 'sudo apt-get install -y docker-compose-plugin || sudo apt-get install -y docker-compose').catch(() => {});
            }
            steps.push('🐳 Docker installiert');
          }

          // Ensure docker group for Deep Scan (if Docker is on the system)
          await this.ssh(host, user, 'id -nG | grep -q docker || sudo usermod -aG docker $USER 2>/dev/null').catch(() => {});

          // Install qemu-guest-agent for Proxmox integration
          if (isRhel) {
            await this.ssh(host, user, 'sudo dnf install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent').catch(() => {});
          } else {
            await this.ssh(host, user, 'sudo apt-get install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent').catch(() => {});
          }
          steps.push('📡 qemu-guest-agent installiert');
        }
      } else {
        // Existing host
        if (!host) return { success: false, error: 'host erforderlich für target=existing' };
        steps.push(`🖥️ Bestehender Host: ${host}`);
      }

      // ── STEP 2: Deploy Code (skipped for provision-only) ──
      if (input._skip_deploy) {
        steps.push('✅ Provisionierung abgeschlossen (kein Code-Deploy)');
      } else {
        const deployResult = await this.doDeploy(host!, user, input, pm, runtime);
        if (!deployResult.success) return { ...deployResult, data: { steps, ...(deployResult.data as Record<string, unknown> ?? {}) } };
        const deploySteps = (deployResult.data as Record<string, unknown>)?.steps as string[] ?? [];
        steps.push(...deploySteps);
      }

      // ── STEP 3: Firewall ──
      if (!input.skip_firewall && appPort && !this.firewallFn) {
        steps.push('⚠️ Firewall: übersprungen (pfSense nicht konfiguriert)');
      }
      if (!input.skip_firewall && appPort && this.firewallFn) {
        const npmTarget = input.npm_target as string | undefined;
        if (npmTarget) {
          const r = await this.firewallFn({
            action: 'create_rule',
            source: npmTarget,
            destination: host!,
            destination_port: String(appPort),
            protocol: 'tcp',
            description: `NPM → ${project} (${host}:${appPort})`,
          });
          steps.push(r.success ? `🔥 Firewall: ${npmTarget} → ${host}:${appPort}` : `⚠️ Firewall: ${r.error}`);
        }
      }

      // ── STEP 4: Reverse Proxy ──
      if (!input.skip_proxy && domain && appPort && !this.npmFn) {
        steps.push('⚠️ Proxy: übersprungen (NPM nicht konfiguriert)');
      }
      if (!input.skip_proxy && domain && appPort && this.npmFn) {
        const r = await this.npmFn({
          action: 'create_host',
          domain,
          target_host: host!,
          target_port: appPort,
          ssl: true,
        });
        steps.push(r.success ? `🔒 Proxy: ${domain} → ${host}:${appPort} (SSL)` : `⚠️ Proxy: ${r.error}`);
      }

      // ── STEP 5: DNS ──
      if (!input.skip_dns && domain && !this.cloudflareFn) {
        steps.push('⚠️ DNS: übersprungen (Cloudflare nicht konfiguriert)');
      }
      if (!input.skip_dns && domain && this.cloudflareFn) {
        const publicIp = input.public_ip as string | undefined;
        if (publicIp) {
          const r = await this.cloudflareFn({
            action: 'create_record',
            domain,
            type: 'A',
            name: domain, // Cloudflare accepts full domain name — zone auto-resolved
            content: publicIp,
            proxied: true,
          });
          steps.push(r.success ? `🌍 DNS: ${domain} → ${publicIp}` : `⚠️ DNS: ${r.error}`);
        } else {
          steps.push('⚠️ DNS übersprungen (keine public_ip angegeben)');
        }
      }

      // ── STEP 6: Verify ──
      if (domain) {
        await new Promise(r => setTimeout(r, 5_000));
        try {
          const res = await fetch(`https://${domain}/`, { signal: AbortSignal.timeout(10_000) });
          steps.push(res.ok ? `✅ Verify: https://${domain}/ → ${res.status}` : `⚠️ Verify: HTTP ${res.status}`);
        } catch {
          steps.push(`⚠️ Verify: https://${domain}/ nicht erreichbar (DNS/SSL braucht ggf. etwas Zeit)`);
        }
      }

      const display = `## Full Deploy: ${project}${domain ? ` → ${domain}` : ''}\n\n${steps.join('\n')}`;

      // Notify CMDB about the deployment
      if (this.cmdbCallback) {
        try { await this.cmdbCallback({ host, project, domain, steps }); } catch { /* non-critical */ }
      }

      // Post-deploy: CMDB discovery + Deep Scan + Auto-Service (fire-and-forget)
      if (this.postDeployCallback && host) {
        const userId = ''; // resolved in callback
        this.postDeployCallback(host, project, userId).catch(() => {});
        steps.push('📋 Post-Deploy: CMDB Discovery + Deep Scan + Service-Erstellung gestartet');
      }

      return { success: true, data: { host, project, domain, steps }, display };

    } catch (err) {
      steps.push(`❌ Fehler: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, error: steps.join('\n'), data: { steps } };
    }
  }
}
