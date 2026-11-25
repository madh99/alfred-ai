/**
 * Spec Schwachstellen-Überwachung Etappe A1 — ein Lauf über die gesamte Infrastruktur (Owner 25.11.: „für die komplette Infra“):
 *   Container aller Hosts: Anwendungs-Quellen (GitHub-Repo-Advisories, NVD-CPE, OSV) über die Zuordnung + Trivy-Image-Scan;
 *   Linux-Hosts (auch Proxmox-Knoten): ausstehende Sicherheitsupdates, angereichert über OSV (Debian/Ubuntu);
 *   danach EPSS und KEV je CVE, Stufe je Treffer. Gleiche Images/Versionen werden je Lauf nur einmal abgefragt.
 * Was nicht geprüft werden konnte, steht mit Grund an der Komponente; Quellenfehler im Ergebnis (nie still).
 */
import { epss, githubAdvisories, kev, nvdCpe, osv, zusammenfuehren, type Abruf, type Advisory } from './quellen.js';
import { leseTrivy } from './trivy.js';
import { ANWENDUNGEN, imageRepo, laufendeVersion } from './zuordnung.js';
import { stufe, type Komponente, type Treffer } from './bewertung.js';

export interface LaufDeps {
  container: Array<{ host: string; name: string; image: string; label?: string; digest?: string; lokal?: string }>;
  hosts: Array<{ host: string; os?: { id: string; version: string }; sicherheit: Array<{ paket: string; alt: string; neu: string }> }>;
  abruf: Abruf;
  /** Trivy-Scan (JSON); ohne → Images „nicht geprüft“ */
  trivy?: (ref: string) => Promise<string>;
  /** von außen erreichbar; undefined = unbekannt (keine Port-Daten) → als erreichbar gewertet und benannt (fail-closed) */
  erreichbar: (host: string, container: string) => boolean | undefined;
  /** Vorgeschichte offener Treffer je Komponente: `${id}|${paket}` → erstes Erkennen, zuletzt gespeicherte EPSS/KEV */
  erkannt?: (schluessel: string) => Map<string, Vorher>;
  githubToken?: string; nvdKey?: string;
  pause?: (ms: number) => Promise<void>;
}

export interface Vorher { erkannt: string; epss?: number; kev?: string; stufe?: string }

export interface LaufErgebnis { komponenten: Komponente[]; fehler: string[]; abfragen: { github: number; nvd: number; osv: number; trivy: number } }

const OEKO = (os?: { id: string; version: string }) => {
  if (!os) return undefined;
  if (os.id === 'debian') return `Debian:${os.version.split('.')[0]}`;
  if (os.id === 'ubuntu') return /^\d{2}\.04$/.test(os.version) && Number(os.version.slice(0, 2)) % 2 === 0 ? `Ubuntu:${os.version}:LTS` : `Ubuntu:${os.version}`;
  return undefined;
};

export async function schwachstellenLauf(d: LaufDeps): Promise<LaufErgebnis> {
  const pause = d.pause ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const fehler: string[] = []; const abfragen = { github: 0, nvd: 0, osv: 0, trivy: 0 };
  const appCache = new Map<string, Promise<{ adv: Advisory[]; fehler: string[]; ok: string[] }>>();
  const trivyCache = new Map<string, Promise<{ treffer: Treffer[] } | { fehler: string }>>();
  let nvdZuletzt = 0;

  const anwendungsLage = (repo: string, version: string) => {
    const key = `${repo}@${version}`;
    if (!appCache.has(key)) appCache.set(key, (async () => {
      const a = ANWENDUNGEN[repo]!; const listen: Advisory[][] = []; const f: string[] = []; const ok: string[] = [];
      if (a.github) { abfragen.github++; try { listen.push(await githubAdvisories(d.abruf, a.github, version, d.githubToken)); ok.push('github'); } catch (e) { f.push((e as Error).message); } }
      if (a.cpe) {
        // NVD ohne Schlüssel: höchstens 5 Abfragen je 30 s
        const warten = (d.nvdKey ? 700 : 6500) - (Date.now() - nvdZuletzt); if (warten > 0) await pause(warten);
        abfragen.nvd++; nvdZuletzt = Date.now();
        try { listen.push(await nvdCpe(d.abruf, a.cpe, version, d.nvdKey)); ok.push('nvd'); } catch (e) { f.push((e as Error).message); }
      }
      if (a.osv) { abfragen.osv++; try { listen.push(await osv(d.abruf, a.osv.oekosystem, a.osv.paket, version.replace(/^v/i, ''))); ok.push('osv'); } catch (e) { f.push((e as Error).message); } }
      return { adv: zusammenfuehren(listen), fehler: f, ok };
    })());
    return appCache.get(key)!;
  };

  const trivyLage = (ref: string) => {
    if (!trivyCache.has(ref)) trivyCache.set(ref, (async () => {
      abfragen.trivy++;
      try { return { treffer: leseTrivy(await d.trivy!(ref)).treffer.map(t => ({ ...t, stufe: 'niedrig' as const, basis: true })) }; } catch (e) { return { fehler: `Trivy: ${(e as Error).message.slice(0, 200)}` }; }
    })());
    return trivyCache.get(ref)!;
  };

  const komponenten: Komponente[] = [];
  for (const c of d.container) {
    const repo = imageRepo(c.image); const app = ANWENDUNGEN[repo];
    const version = laufendeVersion(c.image, app?.nurTag ? undefined : c.label);
    const er = d.erreichbar(c.host, c.name);
    const k: Komponente = { schluessel: `${c.host}/${c.name}`, host: c.host, name: c.name, art: 'container', image: c.image, ...(version ? { version } : {}), ...(app ? { anwendung: app.name } : {}), erreichbar: er !== false, treffer: [], nichtGeprueft: [], geprueft: [], quellenFehler: false };
    if (er === undefined) k.nichtGeprueft.push('Erreichbarkeit unbekannt (keine Port-Daten) — als von außen erreichbar gewertet');
    if (app && version) {
      const r = await anwendungsLage(repo, version);
      for (const a of r.adv) k.treffer.push({ ...a, paket: app.name, installiert: version, stufe: 'niedrig' });
      for (const f of r.fehler) k.nichtGeprueft.push(`${app.name}: ${f}`);
      if (r.fehler.length) k.quellenFehler = true;
      k.geprueft.push(...r.ok);
    } else if (app) k.nichtGeprueft.push(`${app.name}: keine laufende Version (Tag ohne Version, kein Versions-Label) — nur Trivy`);
    else k.nichtGeprueft.push('keine Anwendungs-Zuordnung — nur Trivy');
    if (c.lokal) k.nichtGeprueft.push(`Trivy: ${c.lokal}`);
    else if (!d.trivy) k.nichtGeprueft.push('Trivy nicht verfügbar');
    else {
      const ref = c.digest ?? c.image;
      const r = await trivyLage(ref);
      if ('fehler' in r) { k.nichtGeprueft.push(r.fehler); k.quellenFehler = true; }
      else { k.geprueft.push('trivy'); for (const t of r.treffer) if (!k.treffer.some(x => (x.id === t.id || x.aliase.includes(t.id)) && x.paket === t.paket)) k.treffer.push({ ...t }); }
    }
    komponenten.push(k);
  }

  // Ergebnis (nicht den verschluckten Fehler) zwischenspeichern: jeder Host, der einen Fehler aus dem Speicher liest, benennt ihn selbst
  const osvCache = new Map<string, Promise<{ adv: Advisory[] } | { fehler: string }>>();
  for (const h of d.hosts) {
    if (!h.sicherheit.length) continue;
    const eco = OEKO(h.os);
    const k: Komponente = { schluessel: `${h.host}/sicherheitsupdates`, host: h.host, name: 'sicherheitsupdates', art: 'host', erreichbar: false, treffer: [], nichtGeprueft: [], geprueft: [], quellenFehler: false };
    if (!eco) { k.nichtGeprueft.push(`System ${h.os?.id ?? '?'} ${h.os?.version ?? ''} ohne OSV-Ökosystem — ${h.sicherheit.length} Sicherheitsupdates ausstehend`); komponenten.push(k); continue; }
    for (const p of h.sicherheit) {
      const key = `${eco}|${p.paket}|${p.alt}`;
      if (!osvCache.has(key)) { abfragen.osv++; osvCache.set(key, osv(d.abruf, eco, p.paket, p.alt).then(adv => ({ adv }), e => ({ fehler: (e as Error).message }))); }
      const r = await osvCache.get(key)!;
      if ('fehler' in r) { k.nichtGeprueft.push(`${p.paket}: ${r.fehler}`); k.quellenFehler = true; continue; }
      for (const a of r.adv) k.treffer.push({ ...a, paket: p.paket, installiert: p.alt, behoben: a.behoben ?? p.neu, stufe: 'niedrig' });
    }
    if (!k.quellenFehler) k.geprueft.push('osv');
    komponenten.push(k);
  }

  // EPSS + KEV je CVE, dann Stufe je Treffer; erstes Erkennen aus der Vorgeschichte
  const cves = komponenten.flatMap(k => k.treffer.flatMap(t => [t.id, ...t.aliase])).filter(x => x.startsWith('CVE-'));
  // Fail-closed: ist EPSS oder KEV nicht abrufbar, gelten die zuletzt gespeicherten Werte (nie still herabstufen), und kein Befund wird
  // in diesem Lauf als gelöst gewertet (quellenFehler an jeder Komponente)
  let epFehler = false; let kvFehler = false;
  const ep = await epss(d.abruf, cves).catch(e => { fehler.push((e as Error).message); epFehler = true; return new Map<string, number>(); });
  const kv = await kev(d.abruf).catch(e => { fehler.push((e as Error).message); kvFehler = true; return new Map<string, string>(); });
  for (const k of komponenten) {
    if (epFehler || kvFehler) { k.quellenFehler = true; k.nichtGeprueft.push(`${[epFehler ? 'EPSS' : '', kvFehler ? 'KEV' : ''].filter(Boolean).join(' und ')} nicht abrufbar — zuletzt gespeicherte Werte`); }
    const vor = d.erkannt?.(k.schluessel);
    for (const t of k.treffer) {
      const ids = [t.id, ...t.aliase];
      const alt = vor?.get(`${t.id}|${t.paket}`);
      const e = epFehler ? alt?.epss : ids.map(i => ep.get(i)).find(x => x !== undefined);
      const v = kvFehler ? alt?.kev : ids.map(i => kv.get(i)).find(Boolean);
      if (e !== undefined) t.epss = e;
      if (v) t.kev = v;
      t.stufe = stufe(t, k.erreichbar);
      if (alt) t.erkannt = alt.erkannt;
    }
  }
  return { komponenten, fehler, abfragen };
}
