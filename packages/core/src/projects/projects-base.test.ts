import { describe, it, expect } from 'vitest';
import { resolveProjectsBase, deriveAgentRunAsUser, projectsBaseUnreachableForAgent } from './projects-base.js';

/** v887 — zentrale Projekt-Base-Ableitung (behebt /root-Falle des Wizards). */
describe('resolveProjectsBase', () => {
  it('richtet sich am Agent-User-Home aus (nicht am root-Prozess-Home)', () => {
    // Der reale Vorfall: Prozess läuft als root, Agent als madh
    expect(resolveProjectsBase({ agentRunAsUser: 'madh', processHome: '/root' }))
      .toBe('/home/madh/projects');
  });

  it('ALFRED_PROJECTS_BASE hat höchste Priorität', () => {
    expect(resolveProjectsBase({ envBase: '/data/proj', localBase: '/x', agentRunAsUser: 'madh', processHome: '/root' }))
      .toBe('/data/proj');
  });

  it('localBase überstimmt die Auto-Ableitung (expliziter Override)', () => {
    expect(resolveProjectsBase({ localBase: '/srv/projects', agentRunAsUser: 'madh', processHome: '/root' }))
      .toBe('/srv/projects');
  });

  it('ohne Agent-User: Prozess-Home/projects (Single-User-Fall)', () => {
    expect(resolveProjectsBase({ processHome: '/home/alfred' })).toBe('/home/alfred/projects');
  });

  it('Agent-User = root → Prozess-Home (kein /home/root erfinden)', () => {
    expect(resolveProjectsBase({ agentRunAsUser: 'root', processHome: '/root' })).toBe('/root/projects');
  });

  it('leere Strings werden ignoriert (fallen auf nächste Stufe)', () => {
    expect(resolveProjectsBase({ envBase: '  ', localBase: '', agentRunAsUser: 'madh', processHome: '/root' }))
      .toBe('/home/madh/projects');
  });
});

describe('deriveAgentRunAsUser', () => {
  it('extrahiert User aus sudo -u <user>', () => {
    expect(deriveAgentRunAsUser({ command: 'sudo', argsTemplate: ['-u', 'madh', 'claude', '{{prompt}}'] })).toBe('madh');
  });
  it('kein sudo → undefined', () => {
    expect(deriveAgentRunAsUser({ command: 'claude', argsTemplate: ['{{prompt}}'] })).toBeUndefined();
    expect(deriveAgentRunAsUser(undefined)).toBeUndefined();
  });
});

describe('projectsBaseUnreachableForAgent', () => {
  it('/root-Base + non-root Agent → unzugänglich', () => {
    expect(projectsBaseUnreachableForAgent('/root/projects', 'madh')).toBe(true);
    expect(projectsBaseUnreachableForAgent('/root/.alfred/projects', 'madh')).toBe(true);
  });
  it('/home-Base ist erreichbar', () => {
    expect(projectsBaseUnreachableForAgent('/home/madh/projects', 'madh')).toBe(false);
  });
  it('root-Agent darf unter /root liegen', () => {
    expect(projectsBaseUnreachableForAgent('/root/projects', 'root')).toBe(false);
    expect(projectsBaseUnreachableForAgent('/root/projects', undefined)).toBe(false);
  });
});
