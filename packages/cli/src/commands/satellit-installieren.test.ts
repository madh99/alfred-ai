import { describe, it, expect } from 'vitest';
import { installBefehl, pruefeInstallation, PAKET_MUSTER } from './satellit-installieren.js';

// v1410 R3c — Installieren: feste Quellen, geprüfte Paketnamen, kein freier Befehl
describe('Installieren', () => {
  it('Befehl je Quelle und Plattform; falsche Plattform → null', () => {
    expect(installBefehl('apt', 'ffmpeg', 'linux')).toEqual({ cmd: 'sudo', args: ['-n', 'apt-get', 'install', '-y', '--', 'ffmpeg'] });
    expect(installBefehl('apt', 'ffmpeg', 'darwin')).toBeNull();
    expect(installBefehl('brew', 'jq', 'darwin')).toEqual({ cmd: 'brew', args: ['install', 'jq'] });
    expect(installBefehl('winget', 'Git.Git', 'win32')!.args).toEqual(expect.arrayContaining(['--id', 'Git.Git', '--scope', 'user']));
    expect(installBefehl('winget-system', 'Git.Git', 'win32')!.args).not.toContain('--scope');
    expect(installBefehl('npm', 'pnpm', 'linux')).toEqual({ cmd: 'npm', args: ['install', '-g', '--', 'pnpm'] });
    expect(installBefehl('npm', 'pnpm', 'win32')!.cmd).toBe('npm.cmd');
    expect(installBefehl('pip', 'httpie', 'linux', true)).toEqual({ cmd: 'pipx', args: ['install', 'httpie'] });
    expect(installBefehl('pip', 'httpie', 'linux')).toEqual({ cmd: 'python3', args: ['-m', 'pip', 'install', '--user', '--', 'httpie'] });
  });
  it('Paketnamen: übliche Formen ja, Optionen/Leerzeichen/Shell-Zeichen nein', () => {
    for (const ok of ['pnpm', '@angular/cli', 'Git.Git', 'python3-pip', 'nodejs=20.1.0', 'libc6:i386', 'g++'])
      expect(PAKET_MUSTER.test(ok), ok).toBe(true);
    for (const nein of ['-y', '--force', 'a b', 'x;rm -rf /', 'x&&y', '$(id)', '`id`', 'x|y', 'x>y', ''])
      expect(PAKET_MUSTER.test(nein), nein).toBe(false);
    expect(pruefeInstallation('APT', ' ffmpeg ')).toEqual({ quelle: 'apt', paket: 'ffmpeg' });
    expect(pruefeInstallation('choco', 'x')).toMatch(/quelle muss/);
    expect(pruefeInstallation('apt', '--purge')).toMatch(/ungültig/);
  });
});
