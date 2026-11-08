/**
 * I8c — Skill „windows_ad“: Active Directory über feste Bausteine (windows-ad.ts). Alles außer „status“ nur als Schritt eines
 * freigegebenen Changes. Kennwörter erzeugt bzw. liest der Skill im Tresor und gibt sie nur über die Standardeingabe weiter.
 */
import { randomBytes } from 'node:crypto';
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import {
  adStatusSkript, adStatusText, adErgebnis, dcBereit, mitgliedBereit, kodiert, pruefeWald, pruefeDns, waldSkript, dcSkript, beitrittSkript,
  grundstrukturSkript, pruefeGrundstruktur, sicherungSkript, sicherungJetztSkript, papierkorbSkript, dnsEintragSkript, dnsEintragLoeschenSkript,
  pruefeDnsEintrag, dnsClientSkript, AD_OUS_STANDARD, NTP_STANDARD, AD_NETBIOS, type AdStatus,
} from './windows-ad.js';

export interface WindowsAdDeps {
  /** Fernzugriff: festes Skript auf einem Windows-Zugang (Geheimnisse per Standardeingabe) */
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  /** Tests: Wartezeiten */
  schlafe?: (ms: number) => Promise<void>;
}

const NUR_IM_CHANGE = new Set(['wald_anlegen', 'dc_hinzufuegen', 'beitreten', 'grundstruktur', 'sicherung_einrichten', 'sicherung_jetzt', 'papierkorb_beweis', 'dns_eintrag', 'dns_eintrag_loeschen', 'dns_client']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const KENNWORT_ZEICHEN = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** wie die Windows-Fabrik: erfüllt die Komplexitätsregeln (groß, klein, Ziffer, Sonderzeichen) */
export const adKennwort = () => `Al-${Array.from(randomBytes(24), x => KENNWORT_ZEICHEN[x % KENNWORT_ZEICHEN.length]).join('')}9a`;
export const dsrmName = (domaene: string, zugang: string) => `ad-${domaene}-dsrm-${zugang}`;

export class WindowsAdSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'windows_ad',
    category: 'infrastructure',
    description:
      'Active Directory (I8c) über feste, geprüfte PowerShell-Bausteine auf Windows-Fernzugängen (zugang = Name des Fernzugangs). '
      + 'status (lesend, auch außerhalb von Changes): Rolle, Domäne, bei DCs Dienste, PDC, DCs, Papierkorb — als Prüfung mit erwartet „Domänencontroller von <domäne>“ bzw. „Mitglied der Domäne <domäne>“. '
      + 'NUR als Schritte freigegebener Changes: wald_anlegen (zugang, domaene, netbios) — neuer Wald mit DNS auf einem Server der Arbeitsgruppe, DSRM-Kennwort erzeugt Alfred im Tresor (ad-<domäne>-dsrm-<zugang>), Neustart, wartet bis die AD-Dienste laufen (bis 25 min); lokale Konten werden Domänenkonten, der Fernzugang bleibt „alfred“. '
      + 'dc_hinzufuegen (zugang, domaene, netbios, dns = IPs vorhandener DCs, konto_tresor = Tresor-Eintrag mit dem Kennwort von <NETBIOS>\\alfred, z. B. win-dc01-admin) — weiterer DC mit DNS/GC, vorher grundstruktur am ersten DC (alfred in Domänen-Admins). '
      + 'beitreten (zugang, domaene, netbios, dns, konto_tresor, ou optional z. B. Server) — Mitgliedsserver, Neustart, wartet bis beigetreten. '
      + 'grundstruktur (zugang = PDC, ous Standard Server/Clients/Dienstkonten/Admins, ntp Standard at.pool.ntp.org, weiterleiter = DNS-Weiterleiter, z. B. Gateway des AD-Netzes) — OUs mit Löschschutz, AD-Papierkorb (nicht abschaltbar), alfred in Domänen-Admins, NTP am PDC, Weiterleiter, KDS-Schlüssel für gMSA; wiederholbar. '
      + 'sicherung_einrichten (zugang, laufwerk z. B. S, groesse_gb der leeren Zusatzplatte, uhrzeit z. B. 02:30) — Windows-Server-Sicherung, Platte einrichten, tägliche Systemstatus-Sicherung; sicherung_jetzt (zugang, laufwerk) — sofort sichern und Version belegen. '
      + 'papierkorb_beweis (zugang) — Testkonto anlegen, löschen, wiederherstellen, prüfen, wieder entfernen. '
      + 'dns_eintrag (zugang = DC, zone, name, ip) / dns_eintrag_loeschen (zugang, zone, name) — A-Eintrag, z. B. frischer Name für den DNS-Ausfalltest (kein Cache kennt ihn). '
      + 'dns_client (zugang, dns = Liste, Reihenfolge = Bevorzugung) — DNS-Server eines Windows-Rechners setzen, z. B. DCs gegenseitig; Ergebnis nennt die vorherigen (Rückweg: dns_client mit diesen). '
      + 'Alle Änderungen ohne Rückweg außer dns_eintrag ↔ dns_eintrag_loeschen und dns_client (Hochstufen/Beitritt zurücknehmen ist ein eigener Change).',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', ...NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Windows-Fernzugangs (z. B. dc01)' },
        domaene: { type: 'string', description: 'z. B. ad.3033.at' },
        netbios: { type: 'string', description: 'z. B. AD3033' },
        dns: { type: 'array', items: { type: 'string' }, description: 'IPv4 der Domänencontroller (DNS des Rechners)' },
        konto_tresor: { type: 'string', description: 'Tresor-Eintrag mit dem Kennwort des Domänenkontos alfred (z. B. win-dc01-admin)' },
        ou: { type: 'string', description: 'beitreten: OU unterhalb der Domäne, z. B. Server' },
        ous: { type: 'array', items: { type: 'string' } },
        ntp: { type: 'array', items: { type: 'string' } },
        weiterleiter: { type: 'array', items: { type: 'string' } },
        laufwerk: { type: 'string', description: 'Laufwerksbuchstabe der Sicherungsplatte, z. B. S' },
        groesse_gb: { type: 'number' },
        uhrzeit: { type: 'string', description: 'HH:MM' },
        zone: { type: 'string' }, name: { type: 'string' }, ip: { type: 'string' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly d: WindowsAdDeps) { super(); }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim();
    if (action !== 'status' && !NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Windows-Fernzugangs' };
    try {
      switch (action) {
        case 'status': { const s = await this.status(zugang); return { success: true, data: s, display: adStatusText(s) }; }
        case 'wald_anlegen': return await this.wald(zugang, input);
        case 'dc_hinzufuegen': return await this.dc(zugang, input);
        case 'beitreten': return await this.beitritt(zugang, input);
        case 'grundstruktur': return await this.grundstruktur(zugang, input);
        case 'sicherung_einrichten': return await this.sicherung(zugang, input);
        case 'sicherung_jetzt': return await this.sicherungJetzt(zugang, input);
        case 'papierkorb_beweis': return await this.papierkorb(zugang);
        case 'dns_eintrag': case 'dns_eintrag_loeschen': return await this.dnsEintrag(zugang, action, input);
        case 'dns_client': {
          const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
          const r = await this.lauf<{ vorher: string[]; nachher: string[] }>(zugang, dnsClientSkript({ dns }), 'DNS-Server setzen', 120_000);
          return { success: true, data: r, display: `✅ DNS-Server auf ${zugang}: ${r.nachher.join(', ')} (vorher ${r.vorher.join(', ') || 'keine'}) — Rückweg: dns_client mit dns ${JSON.stringify(r.vorher)}` };
        }
      }
    } catch (err) { return { success: false, error: (err as Error).message.slice(0, 800) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T>(zugang: string, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    const r = await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck);
    const e = adErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e) {
      const fehler = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ').replace(/\s+/g, ' ').slice(-500);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${fehler || 'keine Ausgabe'}`);
    }
    return e;
  }

  private status(zugang: string): Promise<AdStatus> { return this.lauf<AdStatus>(zugang, adStatusSkript(), 'AD-Status', 120_000); }

  /** Nach dem Neustart: erst 60 s, dann alle 20 s den Status lesen (SSH ist dazwischen weg) */
  private async warte(zugang: string, bereit: (s: AdStatus) => boolean, grenzeMs: number): Promise<AdStatus> {
    const schlafe = this.d.schlafe ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const bis = Date.now() + grenzeMs; let letzter: AdStatus | undefined; let fehler = '';
    await schlafe(60_000);
    while (Date.now() < bis) {
      try { letzter = await this.status(zugang); if (bereit(letzter)) return letzter; fehler = ''; } catch (err) { fehler = (err as Error).message.slice(0, 200); }
      await schlafe(20_000);
    }
    throw new Error(`${zugang} nach ${Math.round(grenzeMs / 60_000)} min nicht bereit — zuletzt: ${letzter ? adStatusText(letzter) : fehler || 'kein Status'}`);
  }

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  private domaeneUndNetbios(input: Record<string, unknown>): { domaene: string; netbios: string } {
    const p = { domaene: String(input.domaene ?? '').trim().toLowerCase(), netbios: String(input.netbios ?? '').trim().toUpperCase() };
    const f = pruefeWald(p); if (f) throw new Error(f);
    return p;
  }

  private async kontoKennwort(input: Record<string, unknown>, wofuer: string): Promise<string> {
    const n = String(input.konto_tresor ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(n)) throw new Error('konto_tresor: Tresor-Eintrag mit dem Kennwort des Domänenkontos alfred (z. B. win-dc01-admin)');
    if (!(await this.tresor().namen()).has(n)) throw new Error(`Tresor-Eintrag ${n} gibt es nicht`);
    return this.tresor().lies(n, wofuer);
  }

  private async dsrm(domaene: string, zugang: string): Promise<{ name: string; wert: string }> {
    const t = this.tresor(); const name = dsrmName(domaene, zugang);
    if ((await t.namen()).has(name)) return { name, wert: await t.lies(name, `DSRM-Kennwort für ${zugang}`) };
    const wert = adKennwort();
    await t.setze(name, wert, `DSRM-Kennwort (Wiederherstellungsmodus) des Domänencontrollers ${zugang} in ${domaene}`);
    return { name, wert };
  }

  private async wald(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const vorher = await this.status(zugang);
    if (dcBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const k = await this.dsrm(p.domaene, zugang);
    const r = await this.lauf<{ zustand: string }>(zugang, waldSkript(p), 'Neuer Wald', 1_800_000, { dsrm: k.wert });
    this.d.protokoll?.('I8c Wald angelegt', { zugang, domaene: p.domaene, zustand: r.zustand });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => dcBereit(x, p.domaene), 25 * 60_000);
    return { success: true, data: { ...s, dsrmTresor: k.name }, display: `✅ Wald ${p.domaene} (${p.netbios}) angelegt — ${adStatusText(s)}. DSRM-Kennwort im Tresor (${k.name}).` };
  }

  private async dc(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
    const vorher = await this.status(zugang);
    if (dcBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const kennwort = await this.kontoKennwort(input, `weiterer Domänencontroller ${zugang}`);
    const k = await this.dsrm(p.domaene, zugang);
    const r = await this.lauf<{ zustand: string }>(zugang, dcSkript({ ...p, dns }), 'Weiterer Domänencontroller', 1_800_000, { dsrm: k.wert, kennwort });
    this.d.protokoll?.('I8c DC hinzugefügt', { zugang, domaene: p.domaene, zustand: r.zustand });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => dcBereit(x, p.domaene), 25 * 60_000);
    return { success: true, data: { ...s, dsrmTresor: k.name }, display: `✅ ${zugang} ist weiterer Domänencontroller — ${adStatusText(s)}. DSRM-Kennwort im Tresor (${k.name}).` };
  }

  private async beitritt(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
    const ou = typeof input.ou === 'string' && input.ou.trim() ? input.ou.trim() : undefined;
    if (ou && !/^[\p{L}\p{N} ._-]{1,60}$/u.test(ou)) throw new Error('ou: Name einer OU direkt unter der Domäne');
    const vorher = await this.status(zugang);
    if (mitgliedBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const kennwort = await this.kontoKennwort(input, `Domänenbeitritt ${zugang}`);
    const r = await this.lauf<{ zustand: string }>(zugang, beitrittSkript({ ...p, dns, ...(ou ? { ou } : {}) }), 'Domänenbeitritt', 600_000, { kennwort });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => mitgliedBereit(x, p.domaene), 15 * 60_000);
    return { success: true, data: s, display: `✅ ${adStatusText(s)}${ou ? ` (OU ${ou})` : ''}` };
  }

  private async grundstruktur(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const liste = (x: unknown, std: string[]) => (Array.isArray(x) && x.length ? x.map(String) : typeof x === 'string' && x.trim() ? x.split(',').map(s => s.trim()) : std);
    const p = { ous: liste(input.ous, AD_OUS_STANDARD), ntp: liste(input.ntp, NTP_STANDARD), weiterleiter: liste(input.weiterleiter, []) };
    const f = pruefeGrundstruktur(p); if (f) throw new Error(f);
    const r = await this.lauf<Record<string, unknown>>(zugang, grundstrukturSkript(p), 'AD-Grundstruktur', 600_000);
    if (r.papierkorb !== true) throw new Error('AD-Papierkorb nach dem Einschalten nicht aktiv');
    return { success: true, data: r, display: `✅ Grundstruktur auf ${zugang}: OUs ${p.ous.join(', ')}${(r.ous as string[] | undefined)?.length ? ` (neu: ${(r.ous as string[]).join(', ')})` : ' (vorhanden)'}, AD-Papierkorb an, alfred in Domänen-Admins (${String(r.alfredAdmin)}), NTP ${p.ntp.join(', ')}${p.weiterleiter.length ? `, DNS-Weiterleiter ${(r.weiterleiter as string[] | undefined)?.join(', ')}` : ''}, KDS-Schlüssel ${String(r.kds)}` };
  }

  private async sicherung(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const laufwerk = String(input.laufwerk ?? '').trim().toUpperCase(); const groesseGb = Number(input.groesse_gb); const uhrzeit = String(input.uhrzeit ?? '02:30').trim();
    if (!/^[D-Z]$/.test(laufwerk)) throw new Error('laufwerk: ein Buchstabe D–Z');
    if (!Number.isFinite(groesseGb) || groesseGb < 16 || groesseGb > 4096) throw new Error('groesse_gb: Größe der leeren Zusatzplatte (16–4096)');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit)) throw new Error('uhrzeit: HH:MM');
    const r = await this.lauf<Record<string, unknown>>(zugang, sicherungSkript({ laufwerk, groesseGb, uhrzeit }), 'Systemstatus-Sicherung einrichten', 900_000);
    return { success: true, data: r, display: `✅ Systemstatus-Sicherung auf ${zugang}: Laufwerk ${laufwerk}: (${String(r.groesseGb)} GB, ${String(r.freiGb)} GB frei), täglich ${uhrzeit}, Aufgabe ${String(r.aufgabe)}` };
  }

  private async sicherungJetzt(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const laufwerk = String(input.laufwerk ?? '').trim().toUpperCase();
    if (!/^[D-Z]$/.test(laufwerk)) throw new Error('laufwerk: ein Buchstabe D–Z');
    const r = await this.lauf<Record<string, unknown>>(zugang, sicherungJetztSkript({ laufwerk }), 'Systemstatus-Sicherung', 3_600_000);
    return { success: true, data: r, display: `✅ Systemstatus gesichert auf ${zugang} ${laufwerk}: — ${String(r.versionen)} Version(en), neueste ${String(r.neueste)}, ${String(r.freiGb)} GB frei` };
  }

  private async papierkorb(zugang: string): Promise<SkillResult> {
    const kennung = Date.now().toString(36);
    const r = await this.lauf<Record<string, unknown>>(zugang, papierkorbSkript({ kennung }), 'Papierkorb-Beweis', 300_000);
    return { success: true, data: r, display: `✅ AD-Papierkorb belegt: Testkonto ${String(r.konto)} gelöscht, aus dem Papierkorb wiederhergestellt, geprüft und wieder entfernt` };
  }

  private async dnsEintrag(zugang: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = { zone: String(input.zone ?? '').trim().toLowerCase(), name: String(input.name ?? '').trim().toLowerCase(), ...(action === 'dns_eintrag' ? { ip: String(input.ip ?? '').trim() } : {}) };
    const f = pruefeDnsEintrag(p); if (f) throw new Error(f);
    if (action === 'dns_eintrag') {
      const r = await this.lauf<{ zustand: string }>(zugang, dnsEintragSkript(p as { zone: string; name: string; ip: string }), 'DNS-Eintrag', 120_000);
      return { success: true, data: { ...r, fqdn: `${p.name}.${p.zone}`, ip: p.ip }, display: `✅ ${p.name}.${p.zone} → ${p.ip} (${r.zustand})` };
    }
    const r = await this.lauf<{ zustand: string }>(zugang, dnsEintragLoeschenSkript(p), 'DNS-Eintrag löschen', 120_000);
    return { success: true, data: r, display: `✅ ${p.name}.${p.zone} ${r.zustand}` };
  }
}

export { AD_NETBIOS };
