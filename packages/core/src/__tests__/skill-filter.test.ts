import { describe, it, expect } from 'vitest';
import type { SkillCategory, SkillMetadata } from '@alfred/types';
import { selectCategories, filterSkills } from '../skill-filter.js';

const ALL_CATEGORIES: SkillCategory[] = [
  'core', 'productivity', 'information', 'media',
  'automation', 'files', 'infrastructure', 'identity', 'mcp',
];

function available(...cats: SkillCategory[]): Set<SkillCategory> {
  return new Set(cats);
}

describe('selectCategories', () => {
  it('always includes core', () => {
    const result = selectCategories('hello', available(...ALL_CATEGORIES));
    expect(result.has('core')).toBe(true);
  });

  it('matches productivity keywords', () => {
    for (const msg of ['add a todo', 'set a reminder', 'list calendar events', 'send an email', 'find contact']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('productivity'), `"${msg}" should match productivity`).toBe(true);
    }
  });

  it('matches information keywords', () => {
    for (const msg of ['search for cats', 'what is the weather', 'calculate 2+2', 'what time is it']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('information'), `"${msg}" should match information`).toBe(true);
    }
  });

  it('matches media keywords', () => {
    for (const msg of ['take a screenshot', 'read clipboard', 'speak this', 'send voice message']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('media'), `"${msg}" should match media`).toBe(true);
    }
  });

  it('matches automation keywords', () => {
    for (const msg of ['run in background', 'execute shell command', 'schedule a cron job', 'use code_agent']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('automation'), `"${msg}" should match automation`).toBe(true);
    }
  });

  it('matches German time-interval inflections for automation', () => {
    for (const msg of ['Tägliche Strompreise aWATTar kann gelöscht werden', 'stündlicher Report', 'wöchentliches Backup', 'monatlicher Check']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('automation'), `"${msg}" should match automation`).toBe(true);
    }
  });

  it('matches files keywords', () => {
    for (const msg of ['read the file', 'ingest this document', 'download pdf', 'http request']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('files'), `"${msg}" should match files`).toBe(true);
    }
  });

  it('matches infrastructure keywords', () => {
    for (const msg of ['list proxmox vms', 'restart docker container', 'unifi clients', 'homeassistant lights']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('infrastructure'), `"${msg}" should match infrastructure`).toBe(true);
    }
  });

  it('matches identity keywords', () => {
    const result = selectCategories('link my cross platform account', available(...ALL_CATEGORIES));
    expect(result.has('identity')).toBe(true);
  });

  it('matches mcp keywords', () => {
    const result = selectCategories('use mcp tool', available(...ALL_CATEGORIES));
    expect(result.has('mcp')).toBe(true);
  });

  it('falls back to common categories when no keyword matches', () => {
    const result = selectCategories('hello, how are you?', available(...ALL_CATEGORIES));
    // Should include core + common categories (productivity, information, media, automation)
    expect(result.has('core')).toBe(true);
    expect(result.has('productivity')).toBe(true);
    expect(result.has('information')).toBe(true);
    expect(result.has('media')).toBe(true);
    expect(result.has('automation')).toBe(true);
    // Should NOT include heavy categories like infrastructure
    expect(result.has('infrastructure')).toBe(false);
  });

  it('only includes available common categories in fallback', () => {
    const result = selectCategories('hello', available('core', 'productivity'));
    expect(result.has('core')).toBe(true);
    expect(result.has('productivity')).toBe(true);
    expect(result.has('infrastructure')).toBe(false);
  });
});

describe('filterSkills', () => {
  const skills: SkillMetadata[] = [
    { name: 'memory', category: 'core', description: '', riskLevel: 'read', version: '1.0.0', inputSchema: {} },
    { name: 'todo', category: 'productivity', description: '', riskLevel: 'write', version: '1.0.0', inputSchema: {} },
    { name: 'web_search', category: 'information', description: '', riskLevel: 'read', version: '1.0.0', inputSchema: {} },
    { name: 'proxmox', category: 'infrastructure', description: '', riskLevel: 'write', version: '1.0.0', inputSchema: {} },
    { name: 'legacy', description: '', riskLevel: 'read', version: '1.0.0', inputSchema: {} }, // no category → defaults to core
  ];

  it('filters by selected categories', () => {
    const filtered = filterSkills(skills, new Set(['core', 'productivity']));
    expect(filtered.map(s => s.name)).toEqual(['memory', 'todo', 'legacy']);
  });

  it('returns empty when no categories match', () => {
    const filtered = filterSkills(skills, new Set(['mcp']));
    expect(filtered).toEqual([]);
  });

  it('returns all when all categories selected', () => {
    const filtered = filterSkills(skills, new Set(ALL_CATEGORIES));
    expect(filtered.length).toBe(skills.length);
  });
});
