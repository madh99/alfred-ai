/**
 * Spec Infrastruktur-Vorhaben, I4 (Owner 22.10.2026 „I4 wie vorgeschlagen umsetzen“) — Ausführungsmotor für freigegebene Changes.
 *
 * Deterministisch, ohne Modell: Schritt für Schritt ausführen, prüfen, Ergebnis speichern (übersteht Neustarts), CMDB pflegen.
 * Bei Abweichung gilt, was im freigegebenen Plan steht: anhalten (Incident, Meldung, Rückweg NUR als Frage an den Owner —
 * Owner 22.10. „Rückweg nur vorschlagen, dann auf Freigabe warten“), rueckweg (im Plan freigegeben → selbst) oder weiter.
 * Owner-Schritte warten auf das Ja des Owners. Höchstens ein laufender Change je betroffenem Asset.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import { befehlsklasse } from '../fernzugriff/regeln.js';
import { leseDocker, LINUX_BEFEHLE } from './sammler.js';
import { kuerzeDaten, laufBericht, loeseAuf, rueckwegSchritte, textErfuellt, wirkt, MAX_AUSGABE, type ChangeLauf, type SchrittErgebnis } from './change-lauf.js';
import type { ChangeSchritt, Pruefung } from './change-schritte.js';

export interface MotorDeps {
  owner: () => string | undefined;
  itsm: {
    liste(o: string): Promise<CmdbChangeRequest[]>;
    hole(o: string, id: string): Promise<CmdbChangeRequest | null>;
    motorSetze(o: string, id: string, d: { status?: 'in_progress' | 'completed' | 'failed' | 'rolled_back' | 'cancelled'; lauf: unknown; result?: string }): Promise<CmdbChangeRequest>;
  };
  /** Skill-Aktion als Owner ausführen (Skill-Sandbox mit Zeitlimit) */
  fuehreAus: (skill: string, input: Record<string, unknown>, timeoutMs: number) => Promise<{ success: boolean; data?: unknown; display?: string; error?: string }>;
  fernLesen: (zugang: string, befehl: string, timeoutMs: number) => Promise<string>;
  fernAusfuehren: (zugang: string, befehl: string, alsRoot: boolean, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  netz: {
    http: (url: string, timeoutMs: number) => Promise<{ status: number; text: string }>;
    port: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    dns: (name: string) => Promise<string[]>;
    ping: (host: string) => Promise<boolean>;
  };
  cmdbProtokoll?: (assetId: string, text: string) => Promise<void>;
  entdecke?: (quellen: string[]) => Promise<string[]>;
  incident?: { anlegen(o: string, d: { titel: string; text: string; schwere: string; assetIds: string[] }): Promise<string>; notiz(o: string, id: string, text: string): Promise<void> };
  melde?: (text: string, dringend: boolean) => Promise<void>;
  /** Frage an den Owner (Button); nach dem Ja ruft die Queue den Skill infrastruktur mit `params` auf */
  frage?: (description: string, params: Record<string, unknown>) => Promise<boolean>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  jetzt?: () => number;
  schlafe?: (ms: number) => Promise<void>;
  /** Wartezeiten (für Tests verkürzbar) */
  takt?: { pruefAbstandMs: number; pruefVersuche: number; taskAbstandMs: number; wartenAbstandMs: number };
}

/** Skills, deren Discovery-Quelle nach einem Change neu gelesen wird (Skill → CMDB-Quelle) */
const QUELLE: Record<string, string> = { proxmox: 'proxmox', docker: 'docker', unifi: 'unifi', nginx_proxy_manager: 'nginx_proxy_manager', pfsense: 'pfsense', mikrotik: 'mikrotik', cloudflare_dns: 'cloudflare_dns', fernzugriff: 'fernzugriff' };
const FRAGE_GUELTIG_MS = 24 * 3_600_000;
const hash = (n: string) => createHash('sha256').update(n).digest('hex');

export class ChangeMotor {
  private readonly laufend = new Set<string>();
  private readonly takt: NonNullable<MotorDeps['takt']>;
  constructor(private readonly d: MotorDeps) {
    this.takt = d.takt ?? { pruefAbstandMs: 5_000, pruefVersuche: 6, taskAbstandMs: 3_000, wartenAbstandMs: 10_000 };
  }

  private jetzt(): number { return this.d.jetzt?.() ?? Date.now(); }
  private iso(): string { return new Date(this.jetzt()).toISOString(); }
  private schlafe(ms: number): Promise<void> { return this.d.schlafe ? this.d.schlafe(ms) : new Promise(r => setTimeout(r, ms)); }
  private log(msg: string, daten: Record<string, unknown>): void { this.d.protokoll?.(msg, daten); }

  /** Freigabe vorhanden, gleich dem aktuellen Fingerabdruck, und die Schritte im Speicher sind dieselben wie beim Start. */
  private freigabeDeckt(frisch: CmdbChangeRequest, start: CmdbChangeRequest): boolean {
    if (!frisch.freigabeFingerabdruck || frisch.freigabeFingerabdruck !== frisch.fingerabdruck || frisch.fingerabdruck !== start.fingerabdruck) return false;
    try { return JSON.stringify(frisch.schritte ?? []) === JSON.stringify(start.schritte ?? []); } catch { return false; }
  }

  /** Anzahl Changes, deren Schritte gerade aktiv laufen (Selbstupdate wartet darauf). */
  aktiv(): number { return this.laufend.size; }

  /**
   * Fällige freigegebene Changes starten, unterbrochene nach einem Neustart behandeln, abgebrochene abschließen.
   * Aufruf: nach jeder Freigabe, beim Start und über das Job-Register.
   */
  async anstossen(): Promise<string[]> {
    const o = this.d.owner(); if (!o) return [];
    const alle = (await this.d.itsm.liste(o)).filter(c => c.schritte?.length);
    const gestartet: string[] = [];
    for (const c of alle) {
      if (this.laufend.has(c.id)) continue;
      const l = c.lauf as ChangeLauf | undefined;
      // Owner hat im Web/Chat abgebrochen, während der Change angehalten war → Bericht nachtragen
      if (c.status === 'cancelled' && l && l.phase !== 'fertig') { await this.beende(o, c, l, 'cancelled', 'vom Owner abgebrochen'); continue; }
      if (c.status === 'in_progress' && l && (l.phase === 'laeuft' || l.phase === 'rueckweg')) { await this.nachNeustart(o, c, l); continue; }
      if (c.status !== 'approved') continue;
      if (c.scheduledAt && Date.parse(c.scheduledAt) > this.jetzt()) continue;
      const abh = (c.abhaengigVon ?? []).map(id => alle.find(x => x.id === id));
      if (abh.some(x => !x || x.status !== 'completed')) continue;
      const belegt = alle.filter(x => x.id !== c.id && x.status === 'in_progress' && (x.lauf as ChangeLauf | undefined)?.phase !== 'fertig').flatMap(x => x.affectedAssetIds);
      if (c.affectedAssetIds.some(a => belegt.includes(a))) { this.log('I4 Change wartet (Asset belegt)', { id: c.id }); continue; }
      gestartet.push(c.id);
      void this.starte(o, c).catch(err => this.log('I4 Motorfehler', { id: c.id, fehler: (err as Error).message }));
    }
    return gestartet;
  }

  private async starte(o: string, c: CmdbChangeRequest): Promise<void> {
    const lauf: ChangeLauf = { phase: 'laeuft', schritt: 1, start: this.iso(), ergebnisse: [] };
    const akt = await this.d.itsm.motorSetze(o, c.id, { status: 'in_progress', lauf });
    this.log('I4 Change gestartet', { id: c.id, titel: c.title, schritte: (c.schritte ?? []).length });
    await this.d.melde?.(`▶️ Change gestartet: ${c.title} (${c.id.slice(0, 8)}, ${(c.schritte ?? []).length} Schritte)`, false);
    await this.weiter(o, akt, lauf);
  }

  /** Schritte ab dem aktuellen ausführen, bis Ende, Owner-Schritt, Anhalten oder Abbruch. */
  async weiter(o: string, c0: CmdbChangeRequest, lauf: ChangeLauf): Promise<void> {
    if (this.laufend.has(c0.id)) return;
    this.laufend.add(c0.id);
    try {
      const schritte = (c0.schritte ?? []) as ChangeSchritt[];
      for (const s of schritte) {
        if (s.nr < lauf.schritt || lauf.ergebnisse.some(e => e.nr === s.nr && e.ok)) continue;
        const frisch = await this.d.itsm.hole(o, c0.id);
        if (!frisch || frisch.status === 'cancelled') { await this.beende(o, frisch ?? c0, lauf, 'cancelled', 'vom Owner abgebrochen'); return; }
        // Sicherheitsbefund 22.10.: vor jedem Schritt (auch nach Neustart/Owner-Ja) — Freigabe deckt genau den gespeicherten Plan
        if (!this.freigabeDeckt(frisch, c0)) { await this.halte(o, c0, lauf, 'Freigabe deckt den gespeicherten Plan nicht mehr (Fingerabdruck geändert) — nichts ausgeführt'); return; }
        lauf.schritt = s.nr; lauf.phase = 'laeuft';
        await this.d.itsm.motorSetze(o, c0.id, { lauf });
        if (s.art === 'owner') { await this.frageOwner(o, c0, lauf, s); return; }
        const e = await this.schritt(s, lauf.ergebnisse);
        lauf.ergebnisse = [...lauf.ergebnisse.filter(x => x.nr !== s.nr), e];
        await this.d.itsm.motorSetze(o, c0.id, { lauf });
        this.log('I4 Schritt', { id: c0.id, nr: s.nr, ok: e.ok, pruefung: e.pruefung?.ok, fehler: e.fehler?.slice(0, 200) });
        if (wirkt(s) && (e.ok || e.aktionOk)) for (const a of c0.affectedAssetIds) await this.d.cmdbProtokoll?.(a, `Change ${c0.id.slice(0, 8)} „${c0.title}“ Schritt ${s.nr}: ${s.titel}${e.ok ? '' : ' (Prüfung gescheitert)'}`).catch(() => undefined);
        if (e.ok) continue;
        if (s.beiFehler === 'weiter') continue;
        const grund = `Schritt ${s.nr} „${s.titel}“: ${e.fehler ?? e.pruefung?.text ?? 'gescheitert'}`;
        if (s.beiFehler === 'rueckweg') { await this.rueckweg(o, c0, lauf, grund); return; }
        await this.halte(o, c0, lauf, grund);
        return;
      }
      // Abschluss: Discovery der berührten Quellen (die CMDB muss den neuen Zustand selbst sehen), Bericht
      const quellen = [...new Set(schritte.filter(wirkt).map(s => QUELLE[s.skill ?? '']).filter((q): q is string => !!q))];
      const disc = quellen.length && this.d.entdecke ? await this.d.entdecke(quellen).catch(err => [`Discovery: ${(err as Error).message}`]) : [];
      await this.beende(o, c0, lauf, 'completed', undefined, disc);
    } finally {
      this.laufend.delete(c0.id);
    }
  }

  /** Einen Schritt ausführen und prüfen (Aktion, Prüfung oder Warten). */
  async schritt(s: ChangeSchritt, ergebnisse: SchrittErgebnis[]): Promise<SchrittErgebnis> {
    const e: SchrittErgebnis = { nr: s.nr, ok: false, start: this.iso() };
    const fertig = (x: Partial<SchrittErgebnis>): SchrittErgebnis => ({ ...e, ...x, ende: this.iso() });
    try {
      if (s.art === 'aktion') {
        const p = loeseAuf(s.parameter ?? {}, ergebnisse);
        if (p.fehler) return fertig({ fehler: p.fehler });
        const r = await this.aktion(s.skill!, s.aktion!, p.wert, s.zeitlimitS * 1000);
        if (!r.ok) return fertig({ fehler: r.fehler, ...(r.ausgabe ? { ausgabe: r.ausgabe } : {}) });
        const basis = { aktionOk: true, ausgabe: r.ausgabe?.slice(0, MAX_AUSGABE), daten: kuerzeDaten(r.daten) };
        if (!s.pruefung) return fertig({ ...basis, ok: true });
        const pr = await this.pruefeMitWiederholung(s.pruefung, [...ergebnisse, { ...e, ...basis, ok: true }], this.takt.pruefVersuche, this.takt.pruefAbstandMs);
        return fertig({ ...basis, ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: `Prüfung nicht erfüllt: ${pr.text}` }) });
      }
      if (s.art === 'pruefung') {
        const pr = await this.pruefeMitWiederholung(s.pruefung!, ergebnisse, this.takt.pruefVersuche, this.takt.pruefAbstandMs);
        return fertig({ ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: `Prüfung nicht erfüllt: ${pr.text}` }) });
      }
      if (s.art === 'warten') {
        if (s.sekunden && !s.pruefung) { await this.schlafe(s.sekunden * 1000); return fertig({ ok: true, ausgabe: `${s.sekunden} s gewartet` }); }
        if (s.sekunden) await this.schlafe(s.sekunden * 1000);
        const versuche = Math.max(1, Math.floor((s.zeitlimitS * 1000) / this.takt.wartenAbstandMs));
        const pr = await this.pruefeMitWiederholung(s.pruefung!, ergebnisse, versuche, this.takt.wartenAbstandMs);
        return fertig({ ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: `Bedingung nach ${s.zeitlimitS} s nicht erfüllt: ${pr.text}` }) });
      }
      return fertig({ fehler: `Schritt-Art ${s.art} kann der Motor nicht selbst ausführen` });
    } catch (err) {
      return fertig({ fehler: (err as Error).message.slice(0, 500) });
    }
  }

  /** Skill-Aktion (Fernzugriff über den internen Weg; Proxmox-Aufgaben bis zum Ende verfolgt). */
  private async aktion(skill: string, aktion: string, p: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; ausgabe?: string; daten?: unknown; fehler?: string }> {
    if (skill === 'fernzugriff' && (aktion === 'lesen' || aktion === 'ausfuehren')) {
      const name = String(p.name ?? ''); const befehl = String(p.befehl ?? '');
      if (aktion === 'lesen' || befehlsklasse(befehl) === 'lesen') { const t = await this.d.fernLesen(name, befehl, timeoutMs); return { ok: true, ausgabe: t, daten: { ausgabe: t.slice(0, 2000) } }; }
      const r = await this.d.fernAusfuehren(name, befehl, p.als_root !== false, timeoutMs);
      return r.code === 0 ? { ok: true, ausgabe: r.stdout, daten: { exit: 0, ausgabe: r.stdout.slice(0, 2000) } } : { ok: false, ausgabe: `${r.stdout}\n${r.stderr}`.trim(), fehler: `Exit ${r.code}: ${r.stderr.trim().slice(-300)}` };
    }
    const r = await this.d.fuehreAus(skill, { ...p, action: aktion }, timeoutMs);
    if (!r.success) return { ok: false, fehler: String(r.error ?? 'Skill-Fehler').slice(0, 500), ...(r.display ? { ausgabe: r.display } : {}) };
    // Proxmox liefert bei Snapshots/Backups sofort eine Aufgabe (UPID) — bis zu ihrem Ende verfolgen
    const upid = (r.data as { upid?: unknown } | undefined)?.upid;
    if (skill === 'proxmox' && typeof upid === 'string' && upid.startsWith('UPID:')) {
      const bis = this.jetzt() + timeoutMs;
      for (;;) {
        const t = await this.d.fuehreAus('proxmox', { action: 'task_status', upid }, 30_000);
        const st = (t.data ?? {}) as { status?: string; exitstatus?: string };
        if (t.success && st.status === 'stopped') {
          if (st.exitstatus && st.exitstatus !== 'OK') return { ok: false, fehler: `Proxmox-Aufgabe endete mit ${st.exitstatus}`, ausgabe: r.display };
          break;
        }
        if (this.jetzt() > bis) return { ok: false, fehler: `Proxmox-Aufgabe nach ${Math.round(timeoutMs / 1000)} s nicht fertig (${upid})`, ausgabe: r.display };
        await this.schlafe(this.takt.taskAbstandMs);
      }
    }
    return { ok: true, ...(r.display ? { ausgabe: r.display } : {}), daten: r.data };
  }

  private async pruefeMitWiederholung(p0: Pruefung, ergebnisse: SchrittErgebnis[], versuche: number, abstandMs: number): Promise<{ ok: boolean; text: string; versuche: number }> {
    const aufgeloest = loeseAuf(p0, ergebnisse);
    if (aufgeloest.fehler) return { ok: false, text: aufgeloest.fehler, versuche: 0 };
    const p = aufgeloest.wert;
    let letzter = '';
    for (let i = 1; i <= versuche; i++) {
      try {
        const r = await this.pruefe(p);
        if (r.ok) return { ok: true, text: r.text, versuche: i };
        letzter = r.text;
      } catch (err) { letzter = (err as Error).message.slice(0, 300); }
      if (i < versuche) await this.schlafe(abstandMs);
    }
    return { ok: false, text: letzter, versuche };
  }

  /** Eine Prüfung genau einmal. */
  async pruefe(p: Pruefung): Promise<{ ok: boolean; text: string }> {
    switch (p.typ) {
      case 'http': {
        const r = await this.d.netz.http(p.ziel!, 15_000);
        if (r.status >= 400) return { ok: false, text: `HTTP ${r.status}` };
        const t = textErfuellt(`${r.status}\n${r.text}`, p);
        return { ok: t.ok, text: t.ok ? `HTTP ${r.status}` : `HTTP ${r.status}, ${t.grund}` };
      }
      case 'port': { const ok = await this.d.netz.port(p.ziel!, p.port!, 5_000); return { ok, text: `${p.ziel}:${p.port} ${ok ? 'offen' : 'nicht erreichbar'}` }; }
      case 'dns': {
        const ips = await this.d.netz.dns(p.ziel!);
        const ok = ips.length > 0 && (!p.erwartet || ips.includes(p.erwartet));
        return { ok, text: `${p.ziel} → ${ips.join(', ') || 'keine Adresse'}` };
      }
      case 'ping': { const ok = await this.d.netz.ping(p.ziel!); return { ok, text: `${p.ziel} ${ok ? 'antwortet' : 'antwortet nicht'}` }; }
      case 'container_healthy': {
        const c = leseDocker(await this.d.fernLesen(p.zugang!, LINUX_BEFEHLE.docker, 60_000)).find(x => x.name === p.container);
        if (!c) return { ok: false, text: `Container ${p.container} nicht gefunden` };
        const ok = c.zustand === 'running' && c.gesundheit !== 'unhealthy' && c.gesundheit !== 'starting';
        return { ok, text: `${c.name}: ${c.status}` };
      }
      case 'datei': {
        try { await this.d.fernLesen(p.zugang!, `ls -la ${p.pfad}`, 30_000); return { ok: true, text: `${p.pfad} vorhanden` }; }
        catch (err) { return { ok: false, text: `${p.pfad}: ${(err as Error).message.slice(0, 120)}` }; }
      }
      case 'befehl': {
        const t = await this.d.fernLesen(p.zugang!, p.befehl!, 60_000);
        const r = textErfuellt(t, p);
        return { ok: r.ok, text: r.ok ? `ok (${t.trim().split('\n').slice(-1)[0]?.slice(0, 80) ?? ''})` : r.grund! };
      }
      case 'skill': {
        const r = await this.d.fuehreAus(p.skill!, { ...(p.parameter ?? {}), action: p.aktion! }, 60_000);
        if (!r.success) return { ok: false, text: `${p.skill}.${p.aktion}: ${String(r.error ?? 'Fehler').slice(0, 160)}` };
        let daten = ''; try { daten = JSON.stringify(r.data ?? ''); } catch { /* egal */ }
        const t = textErfuellt(`${r.display ?? ''}\n${daten}`, p);
        return { ok: t.ok, text: t.ok ? `${p.skill}.${p.aktion} ok` : `${p.skill}.${p.aktion}: ${t.grund}` };
      }
    }
  }

  // ── Anhalten, Rückweg, Owner-Fragen ─────────────────────────

  private async halte(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, grund: string): Promise<void> {
    lauf.phase = 'angehalten'; lauf.grund = grund;
    if (!lauf.incidentId && this.d.incident) {
      lauf.incidentId = await this.d.incident.anlegen(o, { titel: `Change angehalten: ${c.title}`, text: `Change ${c.id} (${c.title}) angehalten.\n${grund}`, schwere: c.riskLevel === 'critical' || c.riskLevel === 'high' ? 'high' : 'medium', assetIds: c.affectedAssetIds }).catch(() => undefined);
    }
    const rw = rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], lauf.ergebnisse);
    let frageGestellt = false;
    if (rw.length && this.d.frage) {
      const nonce = randomUUID();
      lauf.frage = { art: 'rueckweg', hash: hash(nonce), schritt: lauf.schritt, bis: new Date(this.jetzt() + FRAGE_GUELTIG_MS).toISOString() };
      await this.d.itsm.motorSetze(o, c.id, { lauf });
      frageGestellt = await this.d.frage(`⚠️ Change angehalten: ${c.title} (${c.id.slice(0, 8)})\n${grund}\n\nRückweg ausführen? In dieser Reihenfolge:\n${rw.map(s => `  zu Schritt ${s.nr}: ${s.rueckweg!.skill}.${s.rueckweg!.aktion}`).join('\n')}\n\nOhne Ja bleibt der Change angehalten (alternativ im Chat: „Schritt wiederholen“ oder „abbrechen“).`, { action: 'rueckweg_ausfuehren', change: c.id, freigabe: nonce }).catch(() => false);
    }
    await this.d.itsm.motorSetze(o, c.id, { lauf });
    this.log('I4 Change angehalten', { id: c.id, grund: grund.slice(0, 300), incident: lauf.incidentId, rueckwegFrage: frageGestellt });
    await this.d.melde?.(`⚠️ Change angehalten: ${c.title} (${c.id.slice(0, 8)})\n${grund}${frageGestellt ? '\nRückweg wartet auf dein Ja.' : rw.length ? '' : '\nKein Rückweg nötig oder möglich.'}`, true);
  }

  private async frageOwner(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, s: ChangeSchritt): Promise<void> {
    const nonce = randomUUID();
    lauf.phase = 'wartet_owner';
    lauf.frage = { art: 'owner_schritt', hash: hash(nonce), schritt: s.nr, bis: new Date(this.jetzt() + FRAGE_GUELTIG_MS).toISOString() };
    await this.d.itsm.motorSetze(o, c.id, { lauf });
    const ok = await this.d.frage?.(`🧑‍🔧 Change ${c.title} (${c.id.slice(0, 8)}), Schritt ${s.nr}: ${s.titel}\n${s.frage}\n\nErledigt? Nach deinem Ja geht es weiter.`, { action: 'owner_schritt_erledigt', change: c.id, schritt: s.nr, freigabe: nonce }).catch(() => false);
    this.log('I4 wartet auf Owner-Schritt', { id: c.id, nr: s.nr, frage: ok });
    await this.d.melde?.(`🧑‍🔧 Change ${c.title}: Schritt ${s.nr} braucht dich — ${s.frage}`, true);
  }

  /** Antwort auf eine Owner-Frage prüfen und verbrauchen (Hash, Gültigkeit, Art, Schritt). */
  private async verbrauche(o: string, id: string, art: 'owner_schritt' | 'rueckweg', nonce: unknown, schritt?: number): Promise<{ c: CmdbChangeRequest; lauf: ChangeLauf } | string> {
    const c = await this.d.itsm.hole(o, id);
    const l = c?.lauf as ChangeLauf | undefined;
    if (!c || !l?.frage || typeof nonce !== 'string') return 'Keine offene Frage zu diesem Change.';
    if (l.frage.art !== art || l.frage.hash !== hash(nonce) || Date.parse(l.frage.bis) < this.jetzt() || (schritt !== undefined && l.frage.schritt !== schritt)) return 'Diese Freigabe ist ungültig oder abgelaufen.';
    if (c.status !== 'in_progress') return `Change ist ${c.status}.`;
    delete l.frage;
    await this.d.itsm.motorSetze(o, c.id, { lauf: l });
    return { c, lauf: l };
  }

  /** Owner-Ja zu einem Owner-Schritt → Schritt erledigt, weiter. */
  async ownerSchrittErledigt(o: string, id: string, schritt: number, nonce: unknown): Promise<string> {
    const v = await this.verbrauche(o, id, 'owner_schritt', nonce, schritt);
    if (typeof v === 'string') return v;
    v.lauf.ergebnisse = [...v.lauf.ergebnisse.filter(e => e.nr !== schritt), { nr: schritt, ok: true, start: this.iso(), ende: this.iso(), ausgabe: 'vom Owner bestätigt' }];
    v.lauf.schritt = schritt + 1; v.lauf.phase = 'laeuft';
    await this.d.itsm.motorSetze(o, v.c.id, { lauf: v.lauf });
    void this.weiter(o, v.c, v.lauf).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return `Schritt ${schritt} als erledigt vermerkt — der Change läuft weiter.`;
  }

  /** Owner-Ja zum Rückweg. */
  async rueckwegNachJa(o: string, id: string, nonce: unknown): Promise<string> {
    const v = await this.verbrauche(o, id, 'rueckweg', nonce);
    if (typeof v === 'string') return v;
    void this.rueckweg(o, v.c, v.lauf, v.lauf.grund ?? 'vom Owner gewählt').catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return 'Rückweg läuft — ich melde das Ergebnis.';
  }

  /** Owner im Chat: angehaltenen Schritt wiederholen oder abbrechen (ohne Rückweg). */
  async steuern(o: string, id: string, wahl: 'wiederholen' | 'abbrechen'): Promise<string> {
    const c = await this.d.itsm.hole(o, id);
    const l = c?.lauf as ChangeLauf | undefined;
    if (!c || !l || c.status !== 'in_progress' || this.laufend.has(c.id)) return 'Der Change ist nicht angehalten.';
    if (l.phase !== 'angehalten') return `Der Change ist nicht angehalten (Phase ${l.phase}).`;
    delete l.frage;
    if (wahl === 'abbrechen') { await this.beende(o, c, l, 'cancelled', 'vom Owner abgebrochen (ohne Rückweg)'); return 'Change abgebrochen, ohne Rückweg. Der Bericht steht im Change.'; }
    l.ergebnisse = l.ergebnisse.filter(e => e.nr !== l.schritt); l.phase = 'laeuft'; delete l.grund;
    await this.d.itsm.motorSetze(o, c.id, { lauf: l });
    void this.weiter(o, c, l).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return `Schritt ${l.schritt} wird wiederholt.`;
  }

  private async rueckweg(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, grund: string): Promise<void> {
    this.laufend.add(c.id);
    try {
      lauf.phase = 'rueckweg'; lauf.grund = grund; lauf.rueckweg = lauf.rueckweg ?? [];
      await this.d.itsm.motorSetze(o, c.id, { lauf });
      const rw = rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], lauf.ergebnisse).filter(s => !lauf.rueckweg!.some(r => r.zuSchritt === s.nr && r.ok));
      let allesOk = true;
      for (const s of rw) {
        const frisch = await this.d.itsm.hole(o, c.id);
        if (!frisch || !this.freigabeDeckt(frisch, c)) { lauf.rueckweg = [...lauf.rueckweg!, { zuSchritt: s.nr, ok: false, text: 'Freigabe deckt den Plan nicht mehr — Rückweg nicht ausgeführt', zeit: this.iso() }]; allesOk = false; break; }
        const p = loeseAuf(s.rueckweg!.parameter ?? {}, lauf.ergebnisse);
        const r = p.fehler ? { ok: false, fehler: p.fehler } : await this.aktion(s.rueckweg!.skill!, s.rueckweg!.aktion!, p.wert, s.zeitlimitS * 1000).catch(err => ({ ok: false, fehler: (err as Error).message }));
        const eintrag = { zuSchritt: s.nr, ok: r.ok, text: r.ok ? `${s.rueckweg!.skill}.${s.rueckweg!.aktion} ok` : String(r.fehler ?? 'gescheitert').slice(0, 300), zeit: this.iso() };
        lauf.rueckweg = [...lauf.rueckweg!, eintrag];
        await this.d.itsm.motorSetze(o, c.id, { lauf });
        this.log('I4 Rückweg-Schritt', { id: c.id, zuSchritt: s.nr, ok: r.ok });
        if (!r.ok) { allesOk = false; break; }
      }
      if (this.d.incident && lauf.incidentId) await this.d.incident.notiz(o, lauf.incidentId, `Rückweg ${allesOk ? 'ausgeführt' : 'GESCHEITERT'}:\n${lauf.rueckweg!.map(r => `${r.ok ? '✓' : '✗'} zu Schritt ${r.zuSchritt}: ${r.text}`).join('\n')}`).catch(() => undefined);
      if (!allesOk && !lauf.incidentId && this.d.incident) lauf.incidentId = await this.d.incident.anlegen(o, { titel: `Rückweg gescheitert: ${c.title}`, text: grund, schwere: 'high', assetIds: c.affectedAssetIds }).catch(() => undefined);
      const quellen = [...new Set(((c.schritte ?? []) as ChangeSchritt[]).filter(wirkt).map(s => QUELLE[s.skill ?? '']).filter((q): q is string => !!q))];
      const disc = quellen.length && this.d.entdecke ? await this.d.entdecke(quellen).catch(() => []) : [];
      await this.beende(o, c, lauf, allesOk ? 'rolled_back' : 'failed', grund, disc);
    } finally {
      this.laufend.delete(c.id);
    }
  }

  /** Nach einem Neustart: lesende Schritte einfach fortsetzen; mitten in einem ändernden Schritt oder Rückweg → anhalten und fragen. */
  private async nachNeustart(o: string, c: CmdbChangeRequest, lauf: ChangeLauf): Promise<void> {
    const s = ((c.schritte ?? []) as ChangeSchritt[]).find(x => x.nr === lauf.schritt);
    const unklar = lauf.phase === 'rueckweg' || (s && (wirkt(s) || s.art === 'owner') && !lauf.ergebnisse.some(e => e.nr === s.nr));
    this.log('I4 Change nach Neustart', { id: c.id, schritt: lauf.schritt, phase: lauf.phase, fortsetzen: !unklar });
    if (!unklar) { void this.weiter(o, c, lauf).catch(err => this.log('I4 Motorfehler', { id: c.id, fehler: (err as Error).message })); return; }
    await this.halte(o, c, lauf, lauf.phase === 'rueckweg' ? 'Neustart während des Rückwegs — Stand unklar' : `Neustart während Schritt ${lauf.schritt} „${s?.titel ?? '?'}“ — unklar, ob er ausgeführt wurde`);
  }

  private async beende(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, status: 'completed' | 'failed' | 'rolled_back' | 'cancelled', grund?: string, discovery: string[] = []): Promise<void> {
    lauf.phase = 'fertig'; lauf.ende = this.iso(); if (grund) lauf.grund = grund; delete lauf.frage;
    const bericht = laufBericht(c.title, (c.schritte ?? []) as ChangeSchritt[], lauf, status) + (discovery.length ? `\nDiscovery danach: ${discovery.join('; ')}` : '');
    await this.d.itsm.motorSetze(o, c.id, { status: c.status === 'cancelled' ? undefined : status, lauf, result: bericht });
    if (this.d.incident && lauf.incidentId && status !== 'completed') await this.d.incident.notiz(o, lauf.incidentId, `Change-Ende: ${status}\n${bericht}`).catch(() => undefined);
    this.log('I4 Change beendet', { id: c.id, status, dauerS: Math.round((Date.parse(lauf.ende) - Date.parse(lauf.start)) / 1000), discovery });
    await this.d.melde?.(`${status === 'completed' ? '✅' : status === 'rolled_back' ? '⏪' : status === 'cancelled' ? '🚫' : '❌'} ${bericht}`, status === 'failed');
  }
}
