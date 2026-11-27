import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillContext } from '@alfred/types';
import { PortainerSkill, dienstImages, imageErsetzen, leseFingerabdruck, tresorName } from './portainer-skill.js';
import { aktionsArt, pruefeChangePlan, type PruefKontext } from './change-schritte.js';

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const DATEI = `version: '3'\nservices:\n  app:\n    image: 'jc21/nginx-proxy-manager:latest'\n    restart: unless-stopped\n    ports:\n      - '80:80'\n  db:\n    image: mariadb:10\n`;
const NEU = 'jc21/nginx-proxy-manager:latest@sha256:' + 'a'.repeat(64);
const TOKEN = 'ptr_geheimestoken123';

function aufbau(o: { datei?: string; containerImage?: (datei: string) => string; putFehler?: boolean } = {}) {
  let datei = o.datei ?? DATEI;
  const aufrufe: Array<{ url: string; methode: string; koerper?: unknown; fp: string; token?: string }> = [];
  const stack = { Id: 1, Name: 'proxy-prod', Type: 2, EndpointId: 2, Status: 1, Env: [{ name: 'DB_PASS', value: 'sehrgeheim' }] };
  const antwort = (wert: unknown, status = 200) => new Response(JSON.stringify(wert), { status });
  const pinnedFetch = async (url: string, init: RequestInit, fp: string) => {
    const methode = init.method ?? 'GET';
    const koerper = init.body ? JSON.parse(String(init.body)) : undefined;
    aufrufe.push({ url, methode, koerper, fp, token: (init.headers as Record<string, string>)['X-API-Key'] });
    const p = new URL(url).pathname;
    if (p === '/api/stacks') return antwort([stack]);
    if (p === '/api/stacks/1/file') return antwort({ StackFileContent: datei });
    if (p === '/api/stacks/1' && methode === 'PUT') { if (o.putFehler) return antwort({ message: 'kaputt ' + TOKEN }, 500); datei = (koerper as { StackFileContent: string }).StackFileContent; return antwort(stack); }
    if (p === '/api/endpoints/2/docker/containers/json') {
      const f = JSON.parse(new URL(url).searchParams.get('filters')!).label as string[];
      const alle = dienstImages(datei).map(d => ({ Id: `c-${d.dienst}`, Image: 'sha256:egal', State: 'running', Labels: { 'com.docker.compose.service': d.dienst } }));
      return antwort(alle.filter(c => f.every(l => !l.startsWith('com.docker.compose.service=') || l.endsWith(`=${c.Labels['com.docker.compose.service']}`))));
    }
    const m = /^\/api\/endpoints\/2\/docker\/containers\/c-([\w-]+)\/json$/.exec(p);
    if (m) { const d = dienstImages(datei).find(x => x.dienst === m[1]); return antwort({ Config: { Image: o.containerImage ? o.containerImage(datei) : d?.image }, State: { Status: 'running' } }); }
    return antwort({ message: 'unbekannt' }, 404);
  };
  return { aufrufe, stack, holeDatei: () => datei, pinnedFetch };
}

async function skill(o: Parameters<typeof aufbau>[0] = {}, tresor = true) {
  const a = aufbau(o);
  const ordner = await mkdtemp(join(tmpdir(), 'portainer-'));
  const gelesen: string[] = [];
  const s = new PortainerSkill({
    hostLesen: async () => ({ code: 0, stdout: `PORTAINER 9443 ${FP}\n`, stderr: '' }),
    hostAdresse: async z => (z === 'authProxy' ? '192.168.1.50' : undefined),
    tresor: { namen: async () => new Set(tresor ? [tresorName('authProxy')] : []), lies: async (n, w) => { gelesen.push(`${n}|${w}`); return TOKEN; } },
    pinnedFetch: a.pinnedFetch as never,
    sicherungsOrdner: ordner,
  });
  return { s, a, ordner, gelesen };
}
const imChange = { userId: 'owner', ausChange: true } as unknown as SkillContext;
const imChat = { userId: 'owner' } as SkillContext;

describe('Portainer-Skill: Hilfsfunktionen', () => {
  it('Dienste und Images, image-Zeile genau eines Dienstes ersetzt, Rest bytegleich', () => {
    expect(dienstImages(DATEI)).toEqual([{ dienst: 'app', image: 'jc21/nginx-proxy-manager:latest', zeile: 3 }, { dienst: 'db', image: 'mariadb:10', zeile: 8 }]);
    const r = imageErsetzen(DATEI, 'app', NEU);
    expect(r.vorher).toBe('jc21/nginx-proxy-manager:latest');
    expect(r.datei).toBe(DATEI.replace("    image: 'jc21/nginx-proxy-manager:latest'", `    image: ${NEU}`));
    expect(() => imageErsetzen(DATEI, 'fehlt', NEU)).toThrow('nicht in der Stack-Datei');
  });
  it('Fingerabdruck aus dem festen Leseschritt; Fehlermarke wird genannt', () => {
    expect(leseFingerabdruck(`PORTAINER 9443 ${FP}`)).toEqual({ port: 9443, fingerabdruck: FP });
    expect(() => leseFingerabdruck('PORTAINER_OHNE_9443_ODER_ZERTIFIKAT')).toThrow('PORTAINER_OHNE_9443_ODER_ZERTIFIKAT');
  });
});

describe('Portainer-Skill: Ausführung', () => {
  it('list_stacks: nur Variablen-NAMEN, Pinning mit dem Host-Fingerabdruck, Token nie in der Ausgabe', async () => {
    const { s, a, gelesen } = await skill();
    const r = await s.execute({ action: 'list_stacks', zugang: 'authProxy' }, imChat);
    expect(r.success).toBe(true);
    expect(r.display).toContain('authProxy: Stack proxy-prod (ID 1, Endpunkt 2, aktiv): Dienste app=jc21/nginx-proxy-manager:latest, db=mariadb:10; Portainer-Variablen DB_PASS; Datei-SHA256 ');
    expect(JSON.stringify(r)).not.toContain('sehrgeheim');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(a.aufrufe.every(x => x.fp === FP && x.url.startsWith('https://192.168.1.50:9443/') && x.token === TOKEN)).toBe(true);
    expect(gelesen).toEqual(['portainer-authproxy|Portainer list_stacks auf authProxy']);
  });

  it('ändernde Aktionen nur im Change; fehlendes Token klar benannt', async () => {
    const { s } = await skill();
    expect((await s.execute({ action: 'image_setzen', zugang: 'authProxy', stack: '1', dienst: 'app', image: NEU }, imChat)).error).toContain('nur als Schritt eines freigegebenen Changes');
    const ohne = await skill({}, false);
    expect((await ohne.s.execute({ action: 'list_stacks', zugang: 'authProxy' }, imChat)).error).toContain('Tresor-Eintrag portainer-authproxy fehlt');
  });

  it('image_setzen: gleiche Variablen, ohne Pull/Prune, Sicherung 600, Datei und Container zurückgelesen; Rückweg stellt die Sicherung wieder her', async () => {
    const { s, a, ordner } = await skill();
    const r = await s.execute({ action: 'image_setzen', zugang: 'authProxy', stack: 'proxy-prod', dienst: 'app', image: NEU }, imChange);
    expect(r.success).toBe(true);
    expect(r.display).toBe(`PORTAINER_IMAGE_GESETZT authProxy Stack proxy-prod Dienst app: jc21/nginx-proxy-manager:latest → ${NEU}; Container läuft`);
    const put = a.aufrufe.find(x => x.methode === 'PUT')!;
    expect(put.url).toBe('https://192.168.1.50:9443/api/stacks/1?endpointId=2');
    expect(put.koerper).toMatchObject({ Env: [{ name: 'DB_PASS', value: 'sehrgeheim' }], Prune: false, PullImage: false });
    const pfad = join(ordner, 'authproxy-stack-1.yml');
    expect(await readFile(pfad, 'utf8')).toBe(DATEI);
    if (process.platform !== 'win32') expect((await stat(pfad)).mode & 0o777).toBe(0o600);
    const z = await s.execute({ action: 'stack_zuruecksetzen', zugang: 'authProxy', stack: '1' }, imChange);
    expect(z.success).toBe(true);
    expect(z.display).toContain('PORTAINER_ZURUECK authProxy Stack proxy-prod: Datei ');
    expect(a.holeDatei()).toBe(DATEI);
  });

  it('abweichender Ist-Stand → nichts geändert, nicht „teilweise“', async () => {
    const { s, a } = await skill();
    const r = await s.execute({ action: 'image_setzen', zugang: 'authProxy', stack: '1', dienst: 'app', image: NEU, datei_sha256: 'f'.repeat(64) }, imChange);
    expect(r.error).toContain('weicht vom erwarteten Stand ab');
    expect(r.data).toBeUndefined();
    expect(a.aufrufe.some(x => x.methode === 'PUT')).toBe(false);
  });

  it('nach dem Neubereitstellen: falsches Container-Image bzw. Fehler beim Bereitstellen → „teilweise“, Token geschwärzt', async () => {
    const { s } = await skill({ containerImage: () => 'jc21/nginx-proxy-manager:latest' });
    const r = await s.execute({ action: 'image_setzen', zugang: 'authProxy', stack: '1', dienst: 'app', image: NEU }, imChange);
    expect(r.success).toBe(false);
    expect(r.data).toEqual({ teilweise: true });
    const k = await skill({ putFehler: true });
    const e = await k.s.execute({ action: 'image_setzen', zugang: 'authProxy', stack: '1', dienst: 'app', image: NEU }, imChange);
    expect(e.data).toEqual({ teilweise: true });
    expect(e.error).toContain('HTTP 500');
    expect(e.error).not.toContain(TOKEN);
  });
});

describe('Portainer-Skill im Change-Validator', () => {
  it('image_setzen ändernd, braucht genau stack_zuruecksetzen auf demselben Zugang und Stack', () => {
    expect(aktionsArt('portainer', 'list_stacks')).toBe('lesen');
    expect(aktionsArt('portainer', 'image_setzen')).toBe('aendern');
    const sk = new PortainerSkill({} as never);
    const ctx = { skill: (n: string) => (n === 'portainer' ? sk : undefined) as never, asset: (k: string) => (k === 'authProxy' ? { id: 'a1', name: 'authProxy' } : undefined), changes: [], jetzt: new Date('2026-11-27T10:00:00Z') } as unknown as PruefKontext;
    const plan = (rueckweg: Record<string, unknown> | undefined) => ({ titel: 'Portainer-Test', begruendung: 'Image eines Stacks setzen', typ: 'normal', risiko: 'mittel', ausfallMinuten: 1, betroffen: ['authProxy'], schritte: [
      { titel: 'Image setzen', art: 'aktion', skill: 'portainer', aktion: 'image_setzen', parameter: { zugang: 'authProxy', stack: '1', dienst: 'app', image: NEU }, ...(rueckweg ? { rueckweg } : {}), beiFehler: 'rueckweg' },
    ] });
    const fehler = (r: Record<string, unknown> | undefined) => pruefeChangePlan(plan(r) as never, ctx).fehler.join(' | ');
    expect(fehler({ skill: 'portainer', aktion: 'stack_zuruecksetzen', parameter: { zugang: 'authProxy', stack: '1' } })).not.toMatch(/stack_zuruecksetzen|denselben Stack/);
    expect(fehler({ skill: 'portainer', aktion: 'stack_zuruecksetzen', parameter: { zugang: 'authProxy', stack: '2' } })).toContain('denselben Stack');
    expect(fehler(undefined)).toContain('rueckweg fehlt');
  });
});
