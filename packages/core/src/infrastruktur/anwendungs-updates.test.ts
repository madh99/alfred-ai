import { describe, expect, it } from 'vitest';
import { befehlsklasse } from '../fernzugriff/regeln.js';
import {
  UPDATE_BEFEHLE, aptArt, containerBefehl, waehleReferenz, berichtText, containerArt, familienBefehl, imageBefehl, leseAptListe, leseImageRef, neueHauptversionen, neuereTags,
  realmErlaubt, registryAbfrage, sammleAnwendungsUpdates,
} from './anwendungs-updates.js';

describe('Anwendungs-Updates — native Pakete', () => {
  it('liest apt list --upgradable mit Sicherheitsquelle', () => {
    const t = 'Listing... Done\npostgresql-16/noble-updates,noble-security 16.10-0ubuntu0.24.04.1 amd64 [upgradable from: 16.9-0ubuntu0.24.04.1]\ncurl/noble-updates 8.5.0-2ubuntu10.7 amd64 [upgradable from: 8.5.0-2ubuntu10.6]';
    const a = leseAptListe(t);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ paket: 'postgresql-16', neu: '16.10-0ubuntu0.24.04.1', alt: '16.9-0ubuntu0.24.04.1', sicherheit: true });
    expect(a[1]!.sicherheit).toBe(false);
    expect(aptArt('postgresql-16')).toBe('datenbank');
    expect(aptArt('curl')).toBe('system');
  });

  it('findet neue Hauptversion einer Familie (postgresql-16 → 18), ignoriert Zusatzpakete', () => {
    const inst = ['postgresql-16', 'postgresql-client-16', 'postgresql-common', 'curl'];
    const verf = ['postgresql-15', 'postgresql-16', 'postgresql-17', 'postgresql-18', 'postgresql-18-postgis-3', 'postgresql-client-18'];
    expect(neueHauptversionen(inst, verf)).toEqual([{ familie: 'postgresql', installiert: '16', verfuegbar: '18' }]);
    expect(neueHauptversionen(['postgresql-18'], verf)).toEqual([]);
    expect(neueHauptversionen(['php8.3'], ['php8.1', 'php8.3', 'php8.4'])).toEqual([{ familie: 'php', installiert: '8.3', verfuegbar: '8.4' }]);
  });

  it('alle Sammelbefehle stehen auf der Leseliste', () => {
    for (const b of [...Object.values(UPDATE_BEFEHLE), familienBefehl('postgresql'), imageBefehl(['nginx:1.27', `sha256:${'a'.repeat(64)}`]), containerBefehl(['web', 'matrix-synapse'])]) expect(befehlsklasse(b), b).toBe('lesen');
    expect(befehlsklasse('apt-cache pkgnames postgresql; rm -f /tmp/x')).not.toBe('lesen');
  });
});

describe('Anwendungs-Updates — Container', () => {
  it('zerlegt Image-Referenzen nach Docker-Regeln', () => {
    expect(leseImageRef('nginx:1.27')).toEqual({ registry: 'registry-1.docker.io', repo: 'library/nginx', tag: '1.27' });
    expect(leseImageRef('vaultwarden/server')).toEqual({ registry: 'registry-1.docker.io', repo: 'vaultwarden/server' });
    expect(leseImageRef('ghcr.io/home-assistant/home-assistant:2026.10')).toEqual({ registry: 'ghcr.io', repo: 'home-assistant/home-assistant', tag: '2026.10' });
    expect(leseImageRef('registry.lokalkraft.at:5000/x/y@sha256:ab')).toEqual({ registry: 'registry.lokalkraft.at:5000', repo: 'x/y', digest: 'sha256:ab' });
  });

  it('Art: Datenbank, mit Daten (Name oder Mounts), zustandslos', () => {
    expect(containerArt({ name: 'db', image: 'postgres:16' })).toBe('datenbank');
    expect(containerArt({ name: 'vw', image: 'vaultwarden/server:latest' })).toBe('mit_daten');
    expect(containerArt({ name: 'web', image: 'nginx:1.27', mounts: ['/srv/conf'] })).toBe('mit_daten');
    expect(containerArt({ name: 'web', image: 'nginx:1.27', mounts: [] })).toBe('zustandslos');
  });

  it('neuere Tags derselben Reihe, getrennt nach Hauptversion', () => {
    const tags = ['1.27', '1.27.1', '1.28', '1.29', '2.0', 'latest', 'alpine', '1.27-alpine', '1.26'];
    expect(neuereTags(tags, '1.27')).toEqual({ gleicheHauptversion: ['1.29', '1.28'], neueHauptversion: ['2.0'] });
    expect(neuereTags(tags, 'latest')).toEqual({ gleicheHauptversion: [], neueHauptversion: [] });
    expect(neuereTags(['16-alpine', '17-alpine', '16.4-alpine'], '16-alpine')).toEqual({ gleicheHauptversion: [], neueHauptversion: ['17-alpine'] });
  });

  it('Registry: Token-Challenge, Digest per HEAD, Tags aus der Hub-API', async () => {
    const aufrufe: string[] = [];
    const abruf = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      aufrufe.push(`${init?.method ?? 'GET'} ${url}`);
      const r = (status: number, body: unknown = {}, h: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, json: async () => body });
      if (url.startsWith('https://auth.docker.io/token')) return r(200, { token: 't1' });
      if (url.includes('/manifests/')) return init?.headers?.Authorization === 'Bearer t1' ? r(200, {}, { 'docker-content-digest': 'sha256:neu' }) : r(401, {}, { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' });
      if (url.startsWith('https://hub.docker.com/')) return r(200, { results: [{ name: '1.29' }, { name: '1.27' }] });
      return r(404);
    };
    const a = await registryAbfrage({ registry: 'registry-1.docker.io', repo: 'library/nginx', tag: '1.27' }, abruf);
    expect(a).toMatchObject({ digest: 'sha256:neu', tags: ['1.29', '1.27'] });
    expect(aufrufe[1]).toContain('scope=repository%3Alibrary%2Fnginx%3Apull');
  });

  it('sammelt Host mit nativer DB und Docker-Host, meldet neuen Build', async () => {
    const A = `sha256:${'a'.repeat(64)}`, B = `sha256:${'b'.repeat(64)}`, C = `sha256:${'c'.repeat(64)}`;
    const antworten: Record<string, Record<string, string>> = {
      'pgsql-p01': {
        [UPDATE_BEFEHLE.os]: 'ID=ubuntu\nVERSION_ID="24.04"',
        [UPDATE_BEFEHLE.apt]: 'postgresql-16/noble-security 16.10 amd64 [upgradable from: 16.9]',
        [UPDATE_BEFEHLE.pakete]: 'ii  postgresql-16\nii  curl\nrc  postgresql-14',
        [familienBefehl('postgresql')]: 'postgresql-16\npostgresql-17',
        [UPDATE_BEFEHLE.docker]: 'inactive',
      },
      'docker-web-01': {
        [UPDATE_BEFEHLE.os]: 'ID=debian',
        [UPDATE_BEFEHLE.apt]: 'Listing... Done',
        [UPDATE_BEFEHLE.pakete]: 'ii  curl',
        [UPDATE_BEFEHLE.docker]: 'active',
        [UPDATE_BEFEHLE.container]: 'web nginx:1.27 \napp registry.lokalkraft.at/x/app:1 daten\nvw cccccccccccc vw-data',
        [containerBefehl(['web', 'app', 'vw'])]: `/web nginx:1.27 ${A}\n/app registry.lokalkraft.at/x/app:1 ${B}\n/vw vaultwarden/server@sha256:d1 ${C}`,
        [imageBefehl([A, B, C])]: `${A} ["nginx:1.27"] ["nginx@sha256:alt"]\n${B} ["registry.lokalkraft.at/x/app:1"] []\n${C} ["vaultwarden/server:1.32.0"] ["vaultwarden/server@sha256:d1"]`,
      },
    };
    const r = await sammleAnwendungsUpdates({
      hosts: [{ name: 'pgsql-p01', updatesSchalter: false }, { name: 'docker-web-01', updatesSchalter: true }],
      lesen: async (z, b) => { const t = antworten[z]?.[b]; if (t === undefined) throw new Error(`unerwartet: ${b}`); return t; },
      abruf: async (url) => ({ status: url.includes('/manifests/') ? 200 : url.includes('hub.docker.com') ? 200 : 401, headers: { get: (n: string) => (n === 'docker-content-digest' ? 'sha256:neu' : null) }, json: async () => ({ results: [{ name: '1.28' }] }) }),
    });
    expect(r.hosts[0]).toMatchObject({ host: 'pgsql-p01', hauptversionen: [{ familie: 'postgresql', installiert: '16', verfuegbar: '17' }] });
    expect(r.container.find(c => c.name === 'web')).toMatchObject({ art: 'zustandslos', neuerBuild: true, gleicheHauptversion: ['1.28'] });
    expect(r.container.find(c => c.name === 'app')).toMatchObject({ art: 'mit_daten', hinweis: 'Registry registry.lokalkraft.at nicht für Abfragen freigegeben' });
    // v1709 — docker ps zeigt nur die ID, Config.Image per Digest: Tag aus RepoTags desselben Repositorys, Digest-Vergleich
    expect(r.container.find(c => c.name === 'vw')).toMatchObject({ image: 'vaultwarden/server:1.32.0', tag: '1.32.0', art: 'mit_daten', neuerBuild: true });
    const t = berichtText(r.hosts, r.container, new Date('2026-11-03T08:00:00Z'));
    expect(t).toContain('postgresql-16 16.9 → 16.10 **Sicherheit** · Datenbank');
    expect(t).toContain('Neue Hauptversion verfügbar: postgresql 16 → 17');
    expect(t).toContain('docker-web-01 / web');
    expect(t).toContain('(wöchentliche OS-Updates an)');
  });
});

describe('Anwendungs-Updates — SSRF-Schutz (v1708)', () => {
  const nie = async () => { throw new Error('darf nicht abgerufen werden'); };
  it('fragt nur freigegebene öffentliche Registries ab', async () => {
    for (const reg of ['192.168.1.91:5432', 'localhost:2375', 'registry.lokalkraft.at', '169.254.169.254'])
      expect((await registryAbfrage({ registry: reg, repo: 'x/y', tag: '1' }, nie)).fehler).toMatch(/nicht für Abfragen freigegeben/);
    expect((await registryAbfrage({ registry: 'ghcr.io', repo: '../../admin', tag: '1' }, nie)).fehler).toMatch(/üblichen Form/);
  });
  it('Token nur per HTTPS vom bekannten Token-Dienst', () => {
    expect(realmErlaubt('registry-1.docker.io', 'https://auth.docker.io/token')).toBe(true);
    for (const r of ['http://auth.docker.io/token', 'https://192.168.1.92:3420/api', 'https://auth.docker.io:8443/t', 'https://evil.example/token', 'https://user@auth.docker.io/t'])
      expect(realmErlaubt('registry-1.docker.io', r), r).toBe(false);
  });
  it('fremder realm in der Challenge wird nicht abgerufen', async () => {
    const aufrufe: string[] = [];
    const abruf = async (url: string) => { aufrufe.push(url); return { status: 401, headers: { get: () => 'Bearer realm="http://192.168.1.91/x",service="s"' }, json: async () => ({}) }; };
    await registryAbfrage({ registry: 'ghcr.io', repo: 'a/b', tag: '1' }, abruf);
    expect(aufrufe.every(u => u.startsWith('https://ghcr.io/'))).toBe(true);
  });
});

describe('Anwendungs-Updates — Referenz trotz Image-ID (v1709)', () => {
  it('wählt angezeigtes Image, Config.Image oder RepoTag', () => {
    expect(waehleReferenz('nginx:1.27', undefined, [])).toBe('nginx:1.27');
    expect(waehleReferenz('3f2a9c1b7d4e', 'nginx:1.27', [])).toBe('nginx:1.27');
    expect(waehleReferenz('3f2a9c1b7d4e', `sha256:${'a'.repeat(64)}`, ['matrixdotorg/synapse:v1.120.0'])).toBe('matrixdotorg/synapse:v1.120.0');
    expect(waehleReferenz('3f2a9c1b7d4e', 'x/y@sha256:1', ['andere/z:1', 'x/y:2'])).toBe('x/y:2');
    expect(waehleReferenz('3f2a9c1b7d4e', 'x/y@sha256:1', [])).toBeUndefined();
  });
});

describe('Anwendungs-Updates — nur per Digest festgelegt (v1710)', () => {
  const D = `sha256:${'d'.repeat(64)}`, I = `sha256:${'e'.repeat(64)}`;
  const lauf = async (hub: Array<{ name: string; digest: string }>) => {
    const a: Record<string, string> = {
      [UPDATE_BEFEHLE.os]: 'ID=ubuntu', [UPDATE_BEFEHLE.apt]: '', [UPDATE_BEFEHLE.pakete]: '', [UPDATE_BEFEHLE.docker]: 'active',
      [UPDATE_BEFEHLE.container]: 'pg eeeeeeeeeeee pgdata',
      [containerBefehl(['pg'])]: `/pg postgres@${D} ${I}`,
      // containerd-Image-Store: die Digest-Referenz steht auch unter RepoTags
      [imageBefehl([I])]: `${I} ["postgres@${D}"] ["postgres@${D}"]`,
    };
    const r = await sammleAnwendungsUpdates({
      hosts: [{ name: 'h', updatesSchalter: false }],
      lesen: async (_z, b) => { if (!(b in a)) throw new Error(b); return a[b]!; },
      abruf: async (url) => ({ status: url.startsWith('https://hub.docker.com/') ? 200 : 404, headers: { get: () => null }, json: async () => ({ results: hub }) }),
    });
    return r.container[0]!;
  };
  it('bestimmt den Tag über den Digest statt gegen latest zu raten', async () => {
    const c = await lauf([{ name: 'latest', digest: 'sha256:x' }, { name: '18.0', digest: 'sha256:x' }, { name: '16.10', digest: D }, { name: '16', digest: D }, { name: '16.11', digest: 'sha256:y' }]);
    expect(c).toMatchObject({ tag: '16.10', neuerBuild: false, gleicheHauptversion: ['16.11'], neueHauptversion: ['18.0'], art: 'datenbank' });
    expect(c.image).toContain('(= 16.10)');
  });
  it('Digest ohne aktuellen Tag: vermutlich veraltet, kein Vergleich gegen latest', async () => {
    const c = await lauf([{ name: 'latest', digest: 'sha256:x' }]);
    expect(c.neuerBuild).toBeUndefined();
    expect(c.hinweis).toMatch(/vermutlich veraltet/);
  });
});

describe('Anwendungs-Updates — Versionen mit v-Präfix (v1711)', () => {
  it('v1.9.8 ist neuer als v0.15.7', () => {
    expect(neuereTags(['v0.15.7', 'v1.9.9', 'v1.10.0', 'v2.0.1'], 'v1.9.8')).toEqual({ gleicheHauptversion: ['v1.10.0', 'v1.9.9'], neueHauptversion: ['v2.0.1'] });
  });
});
