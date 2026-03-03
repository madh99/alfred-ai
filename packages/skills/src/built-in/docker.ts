import type { SkillMetadata, SkillContext, SkillResult, DockerConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Action =
  | 'containers'
  | 'container'
  | 'logs'
  | 'start'
  | 'stop'
  | 'restart'
  | 'images'
  | 'pull_image'
  | 'remove_image'
  | 'networks'
  | 'volumes'
  | 'system_info'
  | 'prune'
  | 'compose_ps'
  | 'compose_up'
  | 'compose_down';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number | undefined | null): string {
  if (n == null || n < 0) return '-';
  if (n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function formatPorts(ports: any[] | undefined): string {
  if (!ports || ports.length === 0) return '-';
  return ports
    .filter((p) => p.PublicPort || p.PrivatePort)
    .map((p) => {
      if (p.PublicPort) {
        return `${p.IP ?? '0.0.0.0'}:${p.PublicPort}->${p.PrivatePort}/${p.Type ?? 'tcp'}`;
      }
      return `${p.PrivatePort}/${p.Type ?? 'tcp'}`;
    })
    .join(', ');
}

function containerName(names: string[] | undefined): string {
  if (!names || names.length === 0) return '-';
  return names.map((n) => n.replace(/^\//, '')).join(', ');
}

function stripDockerStreamHeaders(raw: string): string {
  // Docker multiplexed stream: each frame has an 8-byte header.
  // When reading as text, we strip non-printable leading bytes per line.
  const buf = Buffer.from(raw, 'binary');
  const lines: string[] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      const payload = buf.subarray(offset + 8, offset + 8 + size).toString('utf8');
      lines.push(payload);
      offset += 8 + size;
    } else {
      // Remaining bytes without a full header — treat as raw text
      lines.push(buf.subarray(offset).toString('utf8'));
      break;
    }
  }

  return lines.join('');
}

function relativeTime(epoch: number | undefined): string {
  if (!epoch) return '-';
  const d = new Date(epoch * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// DockerSkill
// ---------------------------------------------------------------------------

export class DockerSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'docker',
    description:
      'Manage Docker containers, images, volumes, networks. ' +
      'Actions: containers, container, logs, start, stop, restart, images, pull_image, ' +
      'remove_image, networks, volumes, system_info, prune, compose_ps, compose_up, compose_down.',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'containers',
            'container',
            'logs',
            'start',
            'stop',
            'restart',
            'images',
            'pull_image',
            'remove_image',
            'networks',
            'volumes',
            'system_info',
            'prune',
            'compose_ps',
            'compose_up',
            'compose_down',
          ],
          description: 'The Docker action to perform',
        },
        containerId: {
          type: 'string',
          description: 'Container ID or name (for container, logs, start, stop, restart)',
        },
        imageName: {
          type: 'string',
          description: 'Image name (for pull_image, remove_image), e.g. nginx, ghcr.io/org/app',
        },
        imageTag: {
          type: 'string',
          description: 'Image tag (for pull_image), default: latest',
        },
        networkId: {
          type: 'string',
          description: 'Network ID or name',
        },
        project: {
          type: 'string',
          description: 'Docker Compose project name (for compose_ps, compose_up, compose_down)',
        },
        tail: {
          type: 'number',
          description: 'Number of log lines to retrieve (default: 100)',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: DockerConfig;
  private readonly defaultSocket: string;

  constructor(config: DockerConfig) {
    super();
    this.config = config;
    this.defaultSocket =
      process.platform === 'win32'
        ? '//./pipe/docker_engine'
        : '/var/run/docker.sock';
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) {
      return { success: false, error: 'Missing required field "action"' };
    }

    try {
      switch (action) {
        case 'containers':
          return await this.listContainers();
        case 'container':
          return await this.inspectContainer(input.containerId as string | undefined);
        case 'logs':
          return await this.getLogs(
            input.containerId as string | undefined,
            input.tail as number | undefined,
          );
        case 'start':
          return await this.startContainer(input.containerId as string | undefined);
        case 'stop':
          return await this.stopContainer(input.containerId as string | undefined);
        case 'restart':
          return await this.restartContainer(input.containerId as string | undefined);
        case 'images':
          return await this.listImages();
        case 'pull_image':
          return await this.pullImage(
            input.imageName as string | undefined,
            input.imageTag as string | undefined,
          );
        case 'remove_image':
          return await this.removeImage(input.imageName as string | undefined);
        case 'networks':
          return await this.listNetworks();
        case 'volumes':
          return await this.listVolumes();
        case 'system_info':
          return await this.getSystemInfo();
        case 'prune':
          return await this.pruneAll();
        case 'compose_ps':
          return await this.composePs(input.project as string | undefined);
        case 'compose_up':
          return await this.composeUp(input.project as string | undefined);
        case 'compose_down':
          return await this.composeDown(input.project as string | undefined);
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Docker API error: ${msg}` };
    }
  }

  // ── HTTP helpers ─────────────────────────────────────────────

  private api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = {
        method,
        path: `/v1.45${path}`,
        headers: { 'Content-Type': 'application/json' },
      };

      if (this.config.host) {
        const url = new URL(this.config.host);
        opts.hostname = url.hostname;
        opts.port = url.port;
      } else {
        opts.socketPath = this.config.socketPath ?? this.defaultSocket;
      }

      const transport = this.config.host?.startsWith('https') ? https : http;
      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Docker API ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) as T : undefined as T);
          } catch {
            reject(new Error(`Invalid JSON from Docker API: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private apiRaw(method: string, path: string, body?: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = {
        method,
        path: `/v1.45${path}`,
        headers: { 'Content-Type': 'application/json' },
      };

      if (this.config.host) {
        const url = new URL(this.config.host);
        opts.hostname = url.hostname;
        opts.port = url.port;
      } else {
        opts.socketPath = this.config.socketPath ?? this.defaultSocket;
      }

      const transport = this.config.host?.startsWith('https') ? https : http;
      const req = transport.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`Docker API ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('binary'));
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── Container actions ────────────────────────────────────────

  private async listContainers(): Promise<SkillResult> {
    const data = await this.api<any[]>('GET', '/containers/json?all=true');

    const lines = [
      '## Docker Containers',
      '',
      '| Name | Image | Status | Ports |',
      '|------|-------|--------|-------|',
    ];

    for (const c of data) {
      lines.push(
        `| ${containerName(c.Names)} | ${c.Image ?? '-'} | ${c.Status ?? c.State ?? '-'} | ${formatPorts(c.Ports)} |`,
      );
    }

    if (data.length === 0) {
      lines.push('| - | No containers found | - | - |');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async inspectContainer(containerId?: string): Promise<SkillResult> {
    if (!containerId) {
      return { success: false, error: 'Missing required "containerId" parameter' };
    }

    const data = await this.api<any>('GET', `/containers/${encodeURIComponent(containerId)}/json`);

    const state = data.State ?? {};
    const config = data.Config ?? {};
    const network = data.NetworkSettings ?? {};
    const mounts = data.Mounts ?? [];

    const portEntries = Object.entries(network.Ports ?? {}) as [string, any[] | null][];
    const portLines = portEntries
      .filter(([, bindings]) => bindings && bindings.length > 0)
      .map(([containerPort, bindings]) => {
        const bound = bindings!
          .map((b: any) => `${b.HostIp ?? '0.0.0.0'}:${b.HostPort}`)
          .join(', ');
        return `${bound} -> ${containerPort}`;
      });

    const mountLines = mounts.map(
      (m: any) => `- ${m.Source ?? '-'} -> ${m.Destination ?? '-'} (${m.Type ?? '-'}, ${m.RW ? 'rw' : 'ro'})`,
    );

    const ipAddress =
      network.IPAddress ||
      Object.values(network.Networks ?? {})
        .map((n: any) => n.IPAddress)
        .filter(Boolean)
        .join(', ') ||
      '-';

    const lines = [
      `## Container: ${containerName(data.Name ? [data.Name] : undefined)}`,
      '',
      `**ID:** ${data.Id?.slice(0, 12) ?? '-'}`,
      `**Image:** ${config.Image ?? '-'}`,
      `**Status:** ${state.Status ?? '-'}`,
      `**Started:** ${state.StartedAt ?? '-'}`,
      `**IP Address:** ${ipAddress}`,
      '',
      '### Ports',
      portLines.length > 0 ? portLines.map((p) => `- ${p}`).join('\n') : '- No port bindings',
      '',
      '### Mounts',
      mountLines.length > 0 ? mountLines.join('\n') : '- No mounts',
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  private async getLogs(containerId?: string, tail?: number): Promise<SkillResult> {
    if (!containerId) {
      return { success: false, error: 'Missing required "containerId" parameter' };
    }

    const tailNum = tail ?? 100;
    const raw = await this.apiRaw(
      'GET',
      `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&tail=${tailNum}`,
    );

    const logText = stripDockerStreamHeaders(raw);

    const lines = [
      `## Logs: ${containerId} (last ${tailNum} lines)`,
      '',
      '```',
      logText.trimEnd(),
      '```',
    ];

    return { success: true, data: logText, display: lines.join('\n') };
  }

  private async startContainer(containerId?: string): Promise<SkillResult> {
    if (!containerId) {
      return { success: false, error: 'Missing required "containerId" parameter' };
    }

    await this.api('POST', `/containers/${encodeURIComponent(containerId)}/start`);
    return {
      success: true,
      data: { containerId, action: 'start' },
      display: `**Container started:** \`${containerId}\``,
    };
  }

  private async stopContainer(containerId?: string): Promise<SkillResult> {
    if (!containerId) {
      return { success: false, error: 'Missing required "containerId" parameter' };
    }

    await this.api('POST', `/containers/${encodeURIComponent(containerId)}/stop`);
    return {
      success: true,
      data: { containerId, action: 'stop' },
      display: `**Container stopped:** \`${containerId}\``,
    };
  }

  private async restartContainer(containerId?: string): Promise<SkillResult> {
    if (!containerId) {
      return { success: false, error: 'Missing required "containerId" parameter' };
    }

    await this.api('POST', `/containers/${encodeURIComponent(containerId)}/restart`);
    return {
      success: true,
      data: { containerId, action: 'restart' },
      display: `**Container restarted:** \`${containerId}\``,
    };
  }

  // ── Image actions ────────────────────────────────────────────

  private async listImages(): Promise<SkillResult> {
    const data = await this.api<any[]>('GET', '/images/json');

    const lines = [
      '## Docker Images',
      '',
      '| Repo:Tag | Size | Created |',
      '|----------|------|---------|',
    ];

    for (const img of data) {
      const tags = img.RepoTags ?? ['<none>:<none>'];
      const repoTag = tags.join(', ');
      const size = formatBytes(img.Size);
      const created = relativeTime(img.Created);
      lines.push(`| ${repoTag} | ${size} | ${created} |`);
    }

    if (data.length === 0) {
      lines.push('| - | No images found | - |');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async pullImage(imageName?: string, imageTag?: string): Promise<SkillResult> {
    if (!imageName) {
      return { success: false, error: 'Missing required "imageName" parameter' };
    }

    const tag = imageTag ?? 'latest';
    const raw = await this.apiRaw(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(imageName)}&tag=${encodeURIComponent(tag)}`,
    );

    // The response is a stream of JSON objects; we just confirm success.
    return {
      success: true,
      data: { imageName, tag, raw: raw.slice(0, 500) },
      display: `**Image pulled:** \`${imageName}:${tag}\``,
    };
  }

  private async removeImage(imageName?: string): Promise<SkillResult> {
    if (!imageName) {
      return { success: false, error: 'Missing required "imageName" parameter' };
    }

    const data = await this.api<any[]>('DELETE', `/images/${encodeURIComponent(imageName)}`);

    const deleted = (data ?? [])
      .filter((e: any) => e.Deleted)
      .map((e: any) => e.Deleted as string);
    const untagged = (data ?? [])
      .filter((e: any) => e.Untagged)
      .map((e: any) => e.Untagged as string);

    const lines = [
      `**Image removed:** \`${imageName}\``,
      '',
      `**Untagged:** ${untagged.length > 0 ? untagged.join(', ') : '-'}`,
      `**Deleted layers:** ${deleted.length}`,
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  // ── Network actions ──────────────────────────────────────────

  private async listNetworks(): Promise<SkillResult> {
    const data = await this.api<any[]>('GET', '/networks');

    const lines = [
      '## Docker Networks',
      '',
      '| Name | Driver | Scope | Subnet |',
      '|------|--------|-------|--------|',
    ];

    for (const net of data) {
      const configs = net.IPAM?.Config ?? [];
      const subnet = configs.map((c: any) => c.Subnet).filter(Boolean).join(', ') || '-';
      lines.push(
        `| ${net.Name ?? '-'} | ${net.Driver ?? '-'} | ${net.Scope ?? '-'} | ${subnet} |`,
      );
    }

    if (data.length === 0) {
      lines.push('| - | No networks found | - | - |');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── Volume actions ───────────────────────────────────────────

  private async listVolumes(): Promise<SkillResult> {
    const result = await this.api<any>('GET', '/volumes');
    const data: any[] = result.Volumes ?? [];

    const lines = [
      '## Docker Volumes',
      '',
      '| Name | Driver | Mountpoint |',
      '|------|--------|------------|',
    ];

    for (const vol of data) {
      lines.push(
        `| ${vol.Name ?? '-'} | ${vol.Driver ?? '-'} | ${vol.Mountpoint ?? '-'} |`,
      );
    }

    if (data.length === 0) {
      lines.push('| - | No volumes found | - |');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── System actions ───────────────────────────────────────────

  private async getSystemInfo(): Promise<SkillResult> {
    const data = await this.api<any>('GET', '/info');

    const lines = [
      '## Docker System Info',
      '',
      `**Docker Version:** ${data.ServerVersion ?? '-'}`,
      `**OS:** ${data.OperatingSystem ?? '-'} (${data.Architecture ?? '-'})`,
      `**Kernel:** ${data.KernelVersion ?? '-'}`,
      `**CPUs:** ${data.NCPU ?? '-'}`,
      `**Memory:** ${formatBytes(data.MemTotal)}`,
      `**Containers:** ${data.Containers ?? '-'} (running: ${data.ContainersRunning ?? '-'}, paused: ${data.ContainersPaused ?? '-'}, stopped: ${data.ContainersStopped ?? '-'})`,
      `**Images:** ${data.Images ?? '-'}`,
      `**Storage Driver:** ${data.Driver ?? '-'}`,
      `**Docker Root Dir:** ${data.DockerRootDir ?? '-'}`,
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  private async pruneAll(): Promise<SkillResult> {
    const [containers, images, volumes, networks] = await Promise.all([
      this.api<any>('POST', '/containers/prune'),
      this.api<any>('POST', '/images/prune'),
      this.api<any>('POST', '/volumes/prune'),
      this.api<any>('POST', '/networks/prune'),
    ]);

    const containerCount = containers.ContainersDeleted?.length ?? 0;
    const imageCount = images.ImagesDeleted?.length ?? 0;
    const volumeCount = volumes.VolumesDeleted?.length ?? 0;
    const networkCount = networks.NetworksDeleted?.length ?? 0;

    const spaceReclaimed =
      (containers.SpaceReclaimed ?? 0) +
      (images.SpaceReclaimed ?? 0) +
      (volumes.SpaceReclaimed ?? 0);

    const lines = [
      '## Docker Prune Results',
      '',
      `**Containers removed:** ${containerCount}`,
      `**Images removed:** ${imageCount}`,
      `**Volumes removed:** ${volumeCount}`,
      `**Networks removed:** ${networkCount}`,
      '',
      `**Total space reclaimed:** ${formatBytes(spaceReclaimed)}`,
    ];

    return {
      success: true,
      data: { containers, images, volumes, networks },
      display: lines.join('\n'),
    };
  }

  // ── Compose actions ──────────────────────────────────────────

  private async composePs(project?: string): Promise<SkillResult> {
    const data = await this.api<any[]>('GET', '/containers/json?all=true');

    // Filter by compose project label
    const composeContainers = data.filter(
      (c) => c.Labels?.['com.docker.compose.project'],
    );

    // Group by project
    const grouped = new Map<string, any[]>();
    for (const c of composeContainers) {
      const proj = c.Labels['com.docker.compose.project'] as string;
      if (project && proj !== project) continue;
      if (!grouped.has(proj)) grouped.set(proj, []);
      grouped.get(proj)!.push(c);
    }

    const lines = ['## Docker Compose Projects', ''];

    if (grouped.size === 0) {
      lines.push(project
        ? `No containers found for project "${project}".`
        : 'No Compose-managed containers found.',
      );
      return { success: true, data: [], display: lines.join('\n') };
    }

    for (const [proj, containers] of grouped) {
      lines.push(`### ${proj}`);
      lines.push('');
      lines.push('| Service | Name | Status | Ports |');
      lines.push('|---------|------|--------|-------|');
      for (const c of containers) {
        const service = c.Labels?.['com.docker.compose.service'] ?? '-';
        lines.push(
          `| ${service} | ${containerName(c.Names)} | ${c.Status ?? c.State ?? '-'} | ${formatPorts(c.Ports)} |`,
        );
      }
      lines.push('');
    }

    return { success: true, data: [...grouped.entries()], display: lines.join('\n') };
  }

  private async composeUp(project?: string): Promise<SkillResult> {
    if (!project) {
      return { success: false, error: 'Missing required "project" parameter' };
    }

    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', '-p', project, 'up', '-d'],
      { timeout: 120_000 },
    );

    const output = (stdout + '\n' + stderr).trim();

    return {
      success: true,
      data: { project, output },
      display: [
        `**Compose up:** \`${project}\``,
        '',
        '```',
        output,
        '```',
      ].join('\n'),
    };
  }

  private async composeDown(project?: string): Promise<SkillResult> {
    if (!project) {
      return { success: false, error: 'Missing required "project" parameter' };
    }

    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', '-p', project, 'down'],
      { timeout: 120_000 },
    );

    const output = (stdout + '\n' + stderr).trim();

    return {
      success: true,
      data: { project, output },
      display: [
        `**Compose down:** \`${project}\``,
        '',
        '```',
        output,
        '```',
      ].join('\n'),
    };
  }
}
