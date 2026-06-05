import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateMcpConfigForClaude,
  generateMcpConfigForCodex,
  generateMcpConfigForVibe,
  patchClaudeMcpConfig,
  patchCodexMcpConfig,
  patchVibeMcpConfig,
} from './cli-config.js';

describe('generators', () => {
  it('claude config is valid JSON with mcpServers.alfred', () => {
    const cfg = generateMcpConfigForClaude('alfred', ['mcp-server']);
    expect(cfg.mcpServers.alfred).toBeDefined();
    expect(cfg.mcpServers.alfred.command).toBe('alfred');
    expect(cfg.mcpServers.alfred.args).toEqual(['mcp-server']);
  });

  it('codex toml has mcp_servers.alfred block', () => {
    const t = generateMcpConfigForCodex('alfred', ['mcp-server']);
    expect(t).toContain('[mcp_servers.alfred]');
    expect(t).toContain('command = "alfred"');
    expect(t).toContain('args = ["mcp-server"]');
  });

  it('vibe toml has [[mcp_servers]] entry with transport=stdio', () => {
    const t = generateMcpConfigForVibe('alfred', ['mcp-server']);
    expect(t).toContain('[[mcp_servers]]');
    expect(t).toContain('transport = "stdio"');
    expect(t).toContain('command = "alfred"');
  });
});

describe('idempotent patching', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alfred-mcp-cfg-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('claude: insert when file missing', () => {
    const p = join(dir, 'mcp.json');
    const r = patchClaudeMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('inserted');
    const content = JSON.parse(readFileSync(p, 'utf-8'));
    expect(content.mcpServers.alfred.command).toBe('alfred');
  });

  it('claude: no-op when already up to date', () => {
    const p = join(dir, 'mcp.json');
    patchClaudeMcpConfig(p, 'alfred', ['mcp-server']);
    const r = patchClaudeMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already up to date');
  });

  it('claude: preserves other user-mcpServers', () => {
    const p = join(dir, 'mcp.json');
    // Pre-existing user config with another server
    require('node:fs').writeFileSync(p, JSON.stringify({
      mcpServers: { 'other-tool': { command: 'foo', args: [] } },
    }));
    patchClaudeMcpConfig(p, 'alfred', ['mcp-server']);
    const content = JSON.parse(readFileSync(p, 'utf-8'));
    expect(content.mcpServers['other-tool']).toBeDefined();
    expect(content.mcpServers.alfred).toBeDefined();
  });

  it('codex: insert + idempotent re-patch', () => {
    const p = join(dir, 'config.toml');
    require('node:fs').writeFileSync(p, '# user config\nmodel = "gpt-5"\n');
    const r1 = patchCodexMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r1.changed).toBe(true);
    expect(r1.reason).toBe('inserted');
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('# user config');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('[mcp_servers.alfred]');

    const r2 = patchCodexMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r2.changed).toBe(false);
  });

  it('vibe: insert + idempotent re-patch', () => {
    const p = join(dir, 'config.toml');
    require('node:fs').writeFileSync(p, 'active_model = "mistral-medium"\nmcp_servers = []\n');
    const r1 = patchVibeMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r1.changed).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('active_model');
    expect(content).toContain('[[mcp_servers]]');
    expect(content).toContain('transport = "stdio"');

    const r2 = patchVibeMcpConfig(p, 'alfred', ['mcp-server']);
    expect(r2.changed).toBe(false);
  });

  it('updates existing Alfred block', () => {
    const p = join(dir, 'config.toml');
    patchCodexMcpConfig(p, 'alfred', ['mcp-server']);
    const r = patchCodexMcpConfig(p, '/usr/local/bin/alfred', ['mcp-server', '--debug']);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('updated');
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('/usr/local/bin/alfred');
    expect(content).toContain('--debug');
  });
});
