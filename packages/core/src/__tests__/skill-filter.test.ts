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

  it('v945: Social-Phrasen erreichen automation (Realfall „Skill nicht in Tool-Liste")', () => {
    for (const msg of [
      'Nutze den social-Skill mit action update_channel, channel FussballCC News, config {"generate_images": true}',
      'Aktualisiere den Kanal FussballCC News: config generate_images: true',
      'Schreibe einen Post für FussballCC News und poste ihn',
      'Erzeuge Content für FussballCC News',
      'Starte das Content-Studio für FussballCC News',
      'Gib die Entwürfe für Instagram frei',
      'Veröffentliche das auf Facebook und Threads',
    ]) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('automation'), `"${msg}" should match automation`).toBe(true);
    }
  });

  it('v945: Interessen-Phrasen erreichen information', () => {
    for (const msg of [
      'Was gibt es Neues zu meinem Thema Claude Fable?',
      'Zeige meine Interessen-Themen',
      'Beobachte das Topic GPU-Preise für mich',
      'Wie ist die aktuelle Entwicklung rund um das Fable-Modell?',
    ]) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('information'), `"${msg}" should match information`).toBe(true);
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
    // Should include core + common categories (productivity, information, media, automation, files)
    expect(result.has('core')).toBe(true);
    expect(result.has('productivity')).toBe(true);
    expect(result.has('information')).toBe(true);
    expect(result.has('media')).toBe(true);
    expect(result.has('automation')).toBe(true);
    expect(result.has('files')).toBe(true);
    // Should NOT include heavy categories like infrastructure
    expect(result.has('infrastructure')).toBe(false);
  });

  it('matches German keywords for productivity', () => {
    for (const msg of ['erstelle eine Notiz', 'erinner mich morgen', 'was steht im Kalender']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('productivity'), `"${msg}" should match productivity`).toBe(true);
    }
  });

  it('matches German keywords for automation', () => {
    for (const msg of ['schreib ein Skript', 'führe diesen Befehl aus', 'Kommando ausführen']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('automation'), `"${msg}" should match automation`).toBe(true);
    }
  });

  it('matches RSS/feed keywords for information', () => {
    for (const msg of ['check my RSS feeds', 'prüfe meinen Feed', 'zeig mir die Nachrichten', 'ORF Schlagzeilen', 'Atom feed abonnieren']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('information'), `"${msg}" should match information`).toBe(true);
    }
  });

  it('includes all categories when automation matches (watches can reference any skill)', () => {
    const result = selectCategories('Erstelle einen Watch für den RSS Feed', available(...ALL_CATEGORIES));
    expect(result.has('automation')).toBe(true);
    expect(result.has('information')).toBe(true);
    expect(result.has('infrastructure')).toBe(true);
    expect(result.has('productivity')).toBe(true);
  });

  it('matches German keywords for media', () => {
    for (const msg of ['generiere ein Bild', 'erstelle ein Foto']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('media'), `"${msg}" should match media`).toBe(true);
    }
  });

  it('matches German keywords for files', () => {
    for (const msg of ['lade die Seite herunter', 'den Anhang speichern']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('files'), `"${msg}" should match files`).toBe(true);
    }
  });

  it('matches German keywords for infrastructure', () => {
    const result = selectCategories('zeig den Netzwerk Status', available(...ALL_CATEGORIES));
    expect(result.has('infrastructure')).toBe(true);
  });

  it('matches charging compound words for infrastructure', () => {
    for (const msg of ['zeig mir die ladehistorie dieses monats', 'letzte ladesession', 'ladevorgang anzeigen', 'ladezyklus der batterie', 'ladekurve']) {
      const result = selectCategories(msg, available(...ALL_CATEGORIES));
      expect(result.has('infrastructure'), `"${msg}" should match infrastructure`).toBe(true);
    }
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

import { werkzeugeFuerNachricht, genannteGeraete, geraeteNamen, selectCategoriesOhneRueckfall } from '../skill-filter.js';

describe('Werkzeugwahl je Nachricht (v1300)', () => {
  const mk = (name: string, category: SkillCategory, description = ''): SkillMetadata => ({ name, description, category, riskLevel: 'low', version: '1', inputSchema: {} } as unknown as SkillMetadata);
  const alle = [
    mk('memory', 'core'), mk('help', 'core'), mk('selbstupdate', 'core'),
    mk('calendar', 'productivity'), mk('email', 'productivity'), mk('web_search', 'information'), mk('weather', 'information'),
    mk('tts', 'media'), mk('shell', 'automation'), mk('file', 'files'), mk('proxmox', 'infrastructure'),
    mk('geraet_office_vm', 'core', 'Gerät „Office-VM" (windows) des Owners — Alfred handelt DORT'),
    mk('geraet_macbook', 'core', 'Gerät „MacBook" (macos) des Owners — Alfred handelt DORT'),
    mk('geraet_pc_madh', 'core', 'Gerät „PC-madh" (windows) des Owners'),
  ];
  const namen = (r: { metas: SkillMetadata[] }) => r.metas.map(m => m.name).sort();

  it('kennt Anzeigename und Kürzel eines Geräts', () => {
    expect(geraeteNamen(alle[11]!)).toEqual(['office-vm', 'office_vm', 'office vm']);
    expect(genannteGeraete('Lies auf Office-VM die Mails', alle).map(m => m.name)).toEqual(['geraet_office_vm']);
    expect(genannteGeraete('was läuft auf dem macbook und dem pc-madh?', alle).map(m => m.name)).toEqual(['geraet_macbook', 'geraet_pc_madh']);
    expect(genannteGeraete('mach das', alle)).toEqual([]);
    expect(genannteGeraete('Macbooks sind teuer', alle)).toEqual([]); // kein Wortende → kein Treffer
  });
  it('Hebel 1: genanntes Gerät → nur dessen Werkzeuge', () => {
    const r = werkzeugeFuerNachricht('Lies auf Office-VM die letzten 5 Mails', ['irgendwas mit Kalender'], alle);
    expect(r.grund).toBe('geraet_genannt');
    expect(namen(r)).toEqual(['geraet_office_vm']);
  });
  it('Hebel 2: Kategorien aus der Nachricht, Geräte nur bei Geräte-Wörtern', () => {
    const r = werkzeugeFuerNachricht('Wie ist das Wetter morgen?', ['starte proxmox vm 101'], alle);
    expect(r.grund).toBe('nachricht');
    expect(namen(r)).toEqual(['help', 'memory', 'selbstupdate', 'weather', 'web_search']);
    const g = werkzeugeFuerNachricht('mach einen Screenshot vom Bildschirm', [], alle);
    expect(g.metas.filter(m => m.name.startsWith('geraet_'))).toHaveLength(3);
  });
  it('Hebel 2: Verlauf nur, wenn die Nachricht selbst nichts trifft; sonst kleiner Rückfall', () => {
    const v = werkzeugeFuerNachricht('ja bitte', ['erstelle mir ein pdf aus der datei'], alle);
    expect(v.grund).toBe('verlauf');
    expect(namen(v)).toContain('file');
    const r = werkzeugeFuerNachricht('danke', [], alle);
    expect(r.grund).toBe('rueckfall');
    expect(namen(r)).toEqual(['calendar', 'email', 'help', 'memory', 'selbstupdate', 'weather', 'web_search']);
    expect(selectCategoriesOhneRueckfall('danke', new Set(['core', 'media']))).toBeUndefined();
  });
  it('v1324: ein zuletzt genanntes Gerät bleibt bei der Rückfrage dabei (Realfall 09.10. „warum setzt du es nicht um?")', () => {
    const r = werkzeugeFuerNachricht('warum setzt du es nicht um ?', ['kannst du am mac bitte mit der camera einen shoot machen'], alle);
    expect(r.grund).toBe('rueckfall');
    expect(namen(r)).toContain('geraet_macbook'); // „mac" ist Gerätewort → alle Geräte, wie im Verlauf-Zweig
    const n = werkzeugeFuerNachricht('wo soll ich es bestätigen?', ['nimm bitte auf dem MacBook ein Foto auf'], alle);
    expect(n.metas.map(m => m.name)).toContain('geraet_macbook');
    const w = werkzeugeFuerNachricht('Wie ist das Wetter morgen?', ['lies auf Office-VM die Mails'], alle);
    expect(w.grund).toBe('nachricht');
    expect(namen(w)).toEqual(['geraet_office_vm', 'help', 'memory', 'selbstupdate', 'weather', 'web_search']); // genanntes Gerät kommt dazu, nicht alle drei
    const o = werkzeugeFuerNachricht('danke', ['bis morgen'], alle);
    expect(namen(o)).not.toContain('geraet_macbook');
  });
});
