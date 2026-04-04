import type { SkillMetadata, SkillContext, SkillResult, InfraDefaultsConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Action = 'deploy' | 'status' | 'logs' | 'stop' | 'start' | 'restart' | 'rollback' | 'setup_node' | 'setup_python';

/**
 * Deploy Skill — SSH-basiertes Deployment auf beliebigen Hosts.
 * Kein Host ist hardcoded — alles wird pro Aufruf angegeben oder aus Infra-Defaults genommen.
 */
export class DeploySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'deploy',
    category: 'infrastructure',
    description:
      'SSH-basiertes Deployment auf beliebigen Hosts. ' +
      '"deploy" klont/pullt ein Git-Repo, installiert Dependencies, baut und startet den Service. ' +
      '"status" zeigt den Service-Status (pm2/systemd). ' +
      '"logs" zeigt die letzten Log-Zeilen. ' +
      '"stop/start/restart" verwalten den Service. ' +
      '"rollback" setzt auf den vorherigen Commit zurück. ' +
      '"setup_node" installiert Node.js auf dem Zielhost. ' +
      '"setup_python" installiert Python + venv auf dem Zielhost. ' +
      'Alle Actions brauchen host (IP/Hostname). Optional: user, port, project, repo_url, app_port, process_manager.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 300_000, // 5 min for deploy
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['deploy', 'status', 'logs', 'stop', 'start', 'restart', 'rollback', 'setup_node', 'setup_python'] },
        host: { type: 'string', description: 'Ziel-IP oder Hostname (erforderlich)' },
        user: { type: 'string', description: 'SSH User (default: aus infra config)' },
        project: { type: 'string', description: 'Projektname (= Verzeichnisname + pm2/systemd Service-Name)' },
        repo_url: { type: 'string', description: 'Git-Repo URL zum Klonen (bei erstem Deploy)' },
        branch: { type: 'string', description: 'Git Branch (default: main)' },
        app_port: { type: 'number', description: 'Port auf dem die App läuft' },
        process_manager: { type: 'string', description: 'pm2, systemd oder docker-compose (default: aus infra config)' },
        runtime: { type: 'string', description: 'node, python oder static (default: aus infra config)' },
        build_command: { type: 'string', description: 'Custom Build-Befehl (default: npm run build)' },
        install_command: { type: 'string', description: 'Custom Install-Befehl (default: npm install --production)' },
        start_command: { type: 'string', description: 'Custom Start-Befehl (default: npm start)' },
        lines: { type: 'number', description: 'Anzahl Log-Zeilen für "logs" Action (default: 50)' },
      },
      required: ['action', 'host'],
    },
  };

  private readonly defaults: InfraDefaultsConfig;

  constructor(defaults?: InfraDefaultsConfig) {
    super();
    this.defaults = defaults ?? {};
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const host = input.host as string;
    if (!host) return { success: false, error: 'host ist erforderlich' };

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
      '-o', 'ConnectTimeout=10',
      `${user}@${host}`,
      command,
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 120_000 });
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

  private async doDeploy(host: string, user: string, input: Record<string, unknown>, pm: string, runtime: string): Promise<SkillResult> {
    const project = input.project as string;
    const repoUrl = input.repo_url as string | undefined;
    const branch = (input.branch as string) ?? 'main';
    const appPort = input.app_port as number | undefined;
    if (!project) return { success: false, error: 'project erforderlich' };

    // 1. Test SSH
    const sshOk = await this.testSsh(host, user);
    if (!sshOk) return { success: false, error: `SSH zu ${user}@${host} fehlgeschlagen. Prüfe Verbindung und SSH Key.` };

    const projectDir = `/home/${user}/${project}`;
    const steps: string[] = [];

    // 2. Clone or pull
    try {
      const dirExists = await this.ssh(host, user, `test -d ${projectDir} && echo yes || echo no`);
      if (dirExists === 'no' && repoUrl) {
        await this.ssh(host, user, `git clone --branch ${branch} ${repoUrl} ${projectDir}`);
        steps.push(`📦 Geklont: ${repoUrl} → ${projectDir}`);
      } else if (dirExists === 'yes') {
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
      ?? (runtime === 'node' ? 'npm install --production' : runtime === 'python' ? 'pip install -r requirements.txt' : '');
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
        const portEnv = appPort ? `PORT=${appPort}` : '';
        // Try restart first, if not running → start
        try {
          await this.ssh(host, user, `cd ${projectDir} && pm2 restart ${project}`);
          steps.push(`🔄 pm2 restart: ${project}`);
        } catch {
          await this.ssh(host, user, `cd ${projectDir} && ${portEnv} pm2 start ${startCmd} --name ${project}`);
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

    await this.ssh(host, user, `cd ${projectDir} && git checkout HEAD~1`);
    steps.push('⏪ Git: HEAD~1');

    if (runtime === 'node') {
      await this.ssh(host, user, `cd ${projectDir} && npm install --production && npm run build --if-present`);
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
}
