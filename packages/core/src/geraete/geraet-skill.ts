import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult, GeraetManifest, GeraetAktionDef } from '@alfred/types';
import { paramsKurz, TRANSFER_MAX_BYTES, TRANSFER_GROSS_MAX_BYTES, sha256Hex, mimeAusName, sichererDateiname } from './protokoll.js';
import { deuteGeraete } from '../normalzustaende/geraete.js'; // v1238

/**
 * v1224 — Skill-Proxy: ein verbundenes Gerät erscheint im Gehirn als Skill `geraet_<name>`.
 * `execute` leitet an das Gerät weiter. Autonomie kommt aus dem Manifest: `bestaetigen`
 * geht in die Bestätigungs-Queue (Owner-Button), `nie` wird abgewiesen, `auto` läuft sofort.
 * Jede Ausführung wird als Schritt im Ausführungsgedächtnis protokolliert (Quelle `geraet`).
 */
/** v1298 — Schrittergebnis im Ausführungsgedächtnis: 300 Zeichen reichten nicht einmal für eine Element-Karte (Spalte ist TEXT). */
export const ERGEBNIS_MAX_ZEICHEN = 2000;

export interface GeraetSkillDeps {
  /** v1268 — nur der Owner (und seine verknüpften Identitäten) bedient seine Geräte. */
  istOwner?: (ctx: SkillContext) => boolean;
  geraetId: string;
  name: string;
  manifest: GeraetManifest;
  skillName: string;
  sendeAktion: (aktion: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<{ success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }>;
  /** Reiht die Frage beim Owner ein; die Queue erhält Parameter mit einer Einmal-Freigabe (v1225). */
  bestaetigung: (frage: { description: string; aktion: string; params: Record<string, unknown> }) => Promise<boolean>;
  /** v1225 — prüft und verbraucht die Einmal-Freigabe aus den Parametern der Bestätigungs-Queue. */
  pruefeFreigabe: (nonce: unknown, aktion: string, params: Record<string, unknown>) => boolean;
  /** v1230 — Vorhaben-Freigabe: anlegen, nach Owner-Ja aktivieren, Deckung prüfen. */
  vorhaben: {
    erzeuge: (v: { beschreibung: string; aktionen: string[]; domains?: string[]; dauerMin?: number }) => { nonce: string; bis: number; aktionen: string[]; domains: string[] };
    aktiviere: (nonce: unknown) => { nonce: string; beschreibung: string; bis: number; aktionen: string[]; domains: string[] } | undefined; // v1297 nonce
    deckt: (aktion: string, params: Record<string, unknown>) => { beschreibung: string; schritte: number } | undefined;
    nachFreigabe?: (v: { nonce: string; beschreibung: string; bis: number; aktionen: string[]; domains: string[] }) => Promise<void>;
  };
  /** v1249 — große Datei für das Gerät bereitstellen (blockweiser Download über HTTPS). */
  transfer?: { bereitstellen: (name: string, data: Buffer) => { id: string; groesse: number; sha256: string; blockGroesse: number } };
  /** v1274 — Gerät entkoppeln: Satellit entfernt sich, Gehirn widerruft das Token. */
  entkoppeln?: () => Promise<{ ok: boolean; geraet?: string; hinweis: string }>;
  /** v1238 — Zustand des Geräts aus den Sinnen (online, Leerlauf, Fenster, Akku), ohne Rückfrage ans Gerät. */
  zustand?: () => import('../normalzustaende/geraete.js').GeraetZustand | undefined;
  /** v1235 — Dateitransfer: Quelle am Server laden (FileStore-Schlüssel oder Serverpfad), geholte Datei ablegen. */
  dateien?: {
    lade: (quelle: string) => Promise<{ name: string; data: Buffer } | undefined>;
    speichere: (name: string, data: Buffer) => Promise<string>;
  };
  schritt?: (s: { art: 'ausgefuehrt' | 'fehlgeschlagen' | 'zur_bestaetigung' | 'blockiert'; aktion: string; params: Record<string, unknown>; beschreibung: string; ergebnis?: string; autonomie: GeraetAktionDef['autonomie'] }) => Promise<void>;
}

export class GeraetSkill extends Skill {
  readonly metadata: SkillMetadata;

  constructor(private readonly deps: GeraetSkillDeps) {
    super();
    const aktionen = deps.manifest.aktionen;
    const params: Record<string, unknown> = {
      action: { type: 'string', enum: ['zustand', ...aktionen.map(a => a.name), 'vorhaben', 'entkoppeln'], description: 'entkoppeln (Bestätigung): Gerät dauerhaft entfernen — Satellit-Dienst und Kopplung dort, Token hier. zustand (auto): Was das Gerät gerade macht — online, Leerlauf, aktives Fenster, Akku; für „was macht mein PC", „ist der PC an", „Akku" IMMER zustand, nie shell. Aktion auf dem Gerät: ' + aktionen.map(a => `${a.name} (${a.autonomie}): ${a.beschreibung}`).join(' | ') + ' | vorhaben: Freigabe für ein mehrschrittiges Vorhaben beim Owner anfordern (beschreibung, aktionen, domains, dauerMin) — nach seinem Ja laufen die genannten Aktionen ohne Einzelbestätigung' },
      beschreibung: { type: 'string', description: 'Nur für vorhaben: was Alfred vorhat, in einem Satz' },
      aktionen: { type: 'array', items: { type: 'string' }, description: 'Nur für vorhaben: Aktionen, die das Vorhaben braucht (z. B. browser_klicken, browser_tippen)' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Nur für vorhaben: erlaubte Domains (z. B. amazon.de)' },
      dauerMin: { type: 'number', description: 'Nur für vorhaben: Gültigkeit in Minuten (Standard 30, höchstens 120)' },
    };
    for (const a of aktionen) for (const [k, p] of Object.entries(a.parameter ?? {})) if (!params[k]) params[k] = { type: p.type, description: p.description ?? `${k} (für ${a.name})` };
    this.metadata = {
      name: deps.skillName,
      category: 'core',
      description: `Gerät „${deps.name}" (${deps.manifest.plattform}) des Owners — Alfred handelt DORT, nicht auf dem Server. Aktionen: ${aktionen.map(a => a.name).join(', ')}. Verändernde Aktionen fragen den Owner vorher (Bestätigung per Button); melde dann nur „zur Bestätigung gestellt". Nutze dieses Gerät, wenn der Owner „auf meinem PC/Mac/Rechner/Laptop" oder den Gerätenamen nennt. Zustand: action=zustand sagt ohne Rückfrage, ob das Gerät online ist, wie lange der Owner nichts eingegeben hat, welches Fenster vorne ist und wie der Akku steht — dafür nie shell. Dateien: datei_holen holt eine Datei vom Gerät (als Anhang + FileStore-key); datei_ablegen legt eine Datei vom Server ab — quelle = FileStore-key (aus „Saved to FileStore … key=…") oder Serverpfad. Browser: browser_oeffnen → browser_lesen (Element-Karte mit Nummern) → browser_klicken/browser_tippen mit der Nummer; nach jedem Klick erneut lesen. Kauf, Bestellung, Zahlung und Anmeldung sind gesperrt — das macht der Owner selbst. Für mehrschrittige Aufgaben (z. B. etwas suchen und in den Einkaufswagen legen) zuerst action=vorhaben mit beschreibung, aktionen und domains anfordern; läuft bereits ein freigegebenes Vorhaben, einfach die Aktionen ausführen.`,
      riskLevel: 'write',
      version: '1.0.0',
      timeoutMs: 11 * 60_000,
      inputSchema: { type: 'object', properties: params, required: ['action'] },
    };
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const aktion = String(input.action ?? '');
    // v1268 — Sicherheitsbefund: Geräte gehören dem Owner; andere Nutzer (Familie, Gäste) bekommen weder Dateien noch Bildschirm
    if (this.deps.istOwner && !this.deps.istOwner(_context)) {
      return { success: false, error: `Das Gerät ${this.deps.name} gehört dem Owner — nur er kann es bedienen.` };
    }
    // v1230 — Vorhaben anfordern: eine Owner-Frage für viele Schritte
    if (aktion === 'vorhaben') {
      const beschreibung = String(input.beschreibung ?? '').trim();
      const aktionen = Array.isArray(input.aktionen) ? (input.aktionen as unknown[]).map(String) : [];
      const domains = Array.isArray(input.domains) ? (input.domains as unknown[]).map(String) : [];
      const bekannt = new Set(this.deps.manifest.aktionen.map(a => a.name));
      const unbekannt = aktionen.filter(a => !bekannt.has(a) && !(a.endsWith('*') && [...bekannt].some(b => b.startsWith(a.slice(0, -1)))));
      if (!beschreibung || aktionen.length === 0) return { success: false, error: 'vorhaben braucht beschreibung und aktionen' };
      if (unbekannt.length) return { success: false, error: `Unbekannte Aktionen im Vorhaben: ${unbekannt.join(', ')}` };
      const gesperrt = this.deps.manifest.aktionen.filter(a => a.autonomie === 'nie' && aktionen.includes(a.name)).map(a => a.name);
      if (gesperrt.length) return { success: false, error: `Diese Aktionen bleiben gesperrt und gehören in kein Vorhaben: ${gesperrt.join(', ')}` };
      const v = this.deps.vorhaben.erzeuge({ beschreibung, aktionen, domains, dauerMin: typeof input.dauerMin === 'number' ? input.dauerMin : undefined });
      const bisText = new Date(v.bis).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
      const frage = `Vorhaben auf ${this.deps.name}: ${beschreibung} — Umfang: ${v.aktionen.join(', ')}${v.domains.length ? ' auf ' + v.domains.join(', ') : ''}, bis ${bisText}. Kauf, Zahlung und Anmeldung bleiben gesperrt.`;
      const gestellt = await this.deps.bestaetigung({ description: frage, aktion: 'vorhaben_freigeben', params: { vorhaben: v.nonce } });
      await this.deps.schritt?.({ art: 'zur_bestaetigung', aktion: 'vorhaben', params: { beschreibung, aktionen: v.aktionen, domains: v.domains }, beschreibung: frage, autonomie: 'bestaetigen' });
      return gestellt
        ? { success: true, data: { zurFreigabe: true, bis: new Date(v.bis).toISOString() }, display: `Vorhaben zur Freigabe an den Owner gestellt: ${beschreibung}. Nach seinem Ja führe ich es ohne Einzelbestätigung aus (${v.aktionen.join(', ')}). Jetzt nichts weiter tun und dem Owner sagen, dass die Freigabe bei ihm liegt.` }
        : { success: false, error: 'Freigabe konnte nicht gestellt werden' };
    }
    // v1274 — Entkoppeln: immer mit Bestätigung, danach gibt es das Gerät nicht mehr
    if (aktion === 'entkoppeln') {
      if (!this.deps.entkoppeln) return { success: false, error: 'Entkoppeln nicht verfügbar' };
      const freigabe = input.freigabe; const bestaetigt = this.deps.pruefeFreigabe(freigabe, 'entkoppeln', {});
      if (!bestaetigt) {
        const frage = `Gerät ${this.deps.name} entkoppeln: Satellit-Dienst und Kopplung dort entfernen, Token hier widerrufen. Danach ist das Gerät weg — neu koppeln nur mit alfred pair.`;
        const gestellt = await this.deps.bestaetigung({ description: frage, aktion: 'entkoppeln', params: {} });
        return gestellt ? { success: true, data: { zurBestaetigung: true }, display: `Zur Bestätigung an den Owner gestellt: ${frage}` } : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
      }
      const r = await this.deps.entkoppeln();
      await this.deps.schritt?.({ art: r.ok ? 'ausgefuehrt' : 'fehlgeschlagen', aktion: 'entkoppeln', params: {}, beschreibung: `Gerät ${this.deps.name} entkoppelt`, ergebnis: r.hinweis, autonomie: 'bestaetigen' });
      return { success: r.ok, data: r, display: r.ok ? `${this.deps.name} entkoppelt — ${r.hinweis}. Die globale CLI dort bleibt installiert (npm uninstall -g @madh-io/alfred-ai entfernt sie).` : `Entkoppeln fehlgeschlagen: ${r.hinweis}`, error: r.ok ? undefined : r.hinweis };
    }
    // v1238 — Zustand aus den Sinnen: keine Shell, keine Bestätigung
    if (aktion === 'zustand') {
      const z = this.deps.zustand?.();
      if (!z) return { success: true, data: { geraet: this.deps.name, online: false }, display: `${this.deps.name} ist gerade nicht verbunden.` };
      const d = deuteGeraete({ geraete: [z] });
      const zeile = d?.zeilen[0] ?? `${z.name}: online`;
      return { success: true, data: { geraet: z.name, online: true, sinne: z.sinne, sinneZeit: z.sinneZeit, verbundenSeit: z.verbundenSeit }, display: `${zeile}${z.sinneZeit ? ` (Sinne von ${new Date(z.sinneZeit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })})` : ''}` };
    }
    if (aktion === 'vorhaben_freigeben') {
      const v = this.deps.vorhaben.aktiviere(input.vorhaben);
      if (!v) return { success: false, error: 'Vorhaben unbekannt oder abgelaufen' };
      await this.deps.schritt?.({ art: 'bestaetigt' as never, aktion: 'vorhaben', params: { aktionen: v.aktionen, domains: v.domains }, beschreibung: `Vorhaben freigegeben: ${v.beschreibung}`, autonomie: 'bestaetigen' });
      void this.deps.vorhaben.nachFreigabe?.(v).catch(() => undefined);
      return { success: true, data: { freigegeben: true, bis: new Date(v.bis).toISOString() }, display: `Vorhaben freigegeben bis ${new Date(v.bis).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}: ${v.beschreibung}. Alfred führt es jetzt aus.` };
    }
    const def = this.deps.manifest.aktionen.find(a => a.name === aktion);
    if (!def) return { success: false, error: `Unbekannte Aktion „${aktion}" auf ${this.deps.name}. Verfügbar: ${this.deps.manifest.aktionen.map(a => a.name).join(', ')}` };
    const params: Record<string, unknown> = { ...input };
    // v1225 — Sicherheitsbefund: `confirmed: true` konnte auch das Modell setzen. Jetzt zählt nur eine
    // Einmal-Freigabe, die das Gehirn beim Einreihen erzeugt hat und die an Aktion + Parameter gebunden ist.
    const freigabe = params.freigabe;
    delete params.freigabe;
    delete params.confirmed;
    const bestaetigt = this.deps.pruefeFreigabe(freigabe, aktion, params);
    const beschreibung = `Auf ${this.deps.name}: ${aktion} ${paramsKurz(params)}`.trim();

    if (def.autonomie === 'nie') {
      await this.deps.schritt?.({ art: 'blockiert', aktion, params, beschreibung, ergebnis: 'Autonomie-Klasse nie', autonomie: 'nie' });
      return { success: false, error: `„${aktion}" auf ${this.deps.name} ist für Alfred gesperrt (Autonomie: nie) — nur der Owner selbst.` };
    }
    // v1230 — ein aktives Vorhaben deckt die Aktion: keine Einzelbestätigung
    const vorhaben = def.autonomie === 'bestaetigen' && !bestaetigt ? this.deps.vorhaben.deckt(aktion, params) : undefined;
    if (def.autonomie === 'bestaetigen' && !bestaetigt && !vorhaben) {
      const gestellt = await this.deps.bestaetigung({ description: beschreibung, aktion, params });
      await this.deps.schritt?.({ art: 'zur_bestaetigung', aktion, params, beschreibung, autonomie: 'bestaetigen' });
      return gestellt
        ? { success: true, data: { zurBestaetigung: true, geraet: this.deps.name, aktion }, display: `Zur Bestätigung an den Owner gestellt: ${beschreibung}. Nach Freigabe wird es auf dem Gerät ausgeführt.` }
        : { success: false, error: 'Bestätigung konnte nicht gestellt werden (keine Bestätigungs-Queue oder Anfrage verworfen) — dem Owner sagen, dass keine Frage bei ihm liegt.' };
    }
    // v1235 — datei_ablegen: Quelle erst jetzt (nach Freigabe) laden; die Nutzlast geht nie durch die Queue
    let geraetParams = params;
    if (aktion === 'datei_ablegen') {
      const quelle = String(params.quelle ?? '');
      if (!quelle) return { success: false, error: 'quelle fehlt (FileStore-Schlüssel oder Serverpfad)' };
      if (!this.deps.dateien) return { success: false, error: 'Dateitransfer am Server nicht eingerichtet' };
      const q = await this.deps.dateien.lade(quelle).catch(() => undefined);
      if (!q) return { success: false, error: `Quelle nicht lesbar: ${quelle}` };
      if (q.data.length > TRANSFER_GROSS_MAX_BYTES) return { success: false, error: `Datei zu groß (${q.data.length} B, Grenze ${TRANSFER_GROSS_MAX_BYTES} B)` };
      if (q.data.length > TRANSFER_MAX_BYTES) {
        // v1249 — über 8 MB: blockweise über HTTPS, das Gerät holt sich die Blöcke mit seinem Token
        if (!this.deps.transfer) return { success: false, error: 'Blockweiser Transfer am Server nicht eingerichtet' };
        const t = this.deps.transfer.bereitstellen(sichererDateiname(q.name), q.data);
        geraetParams = { ...params, dateiName: sichererDateiname(q.name), downloadId: t.id, sha256: t.sha256, groesse: t.groesse, blockGroesse: t.blockGroesse };
      } else {
        geraetParams = { ...params, dateiName: sichererDateiname(q.name), inhaltBase64: q.data.toString('base64'), sha256: sha256Hex(q.data), groesse: q.data.length };
      }
    }
    const r = await this.deps.sendeAktion(aktion, geraetParams, aktion === 'shell' ? 10 * 60_000 : undefined);
    await this.deps.schritt?.({ art: r.success ? 'ausgefuehrt' : 'fehlgeschlagen', aktion, params, beschreibung: vorhaben ? `${beschreibung} (Vorhaben: ${vorhaben.beschreibung.slice(0, 60)}, Schritt ${vorhaben.schritte})` : beschreibung, ergebnis: r.success ? (r.display ?? JSON.stringify(r.data ?? null)).slice(0, ERGEBNIS_MAX_ZEICHEN) : (r.error ?? '').slice(0, ERGEBNIS_MAX_ZEICHEN), autonomie: def.autonomie });
    if (!r.success) return { success: false, error: r.error ?? 'Gerät meldete Fehler' };
    // v1249 — datei_holen über 8 MB: das Gerät hat blockweise hochgeladen, der Server hat schon gespeichert (key)
    const dg = r.data as { key?: string; dateiName?: string; groesse?: number; sha256?: string; gross?: boolean } | undefined;
    if (aktion === 'datei_holen' && dg && typeof dg.key === 'string') {
      const name = sichererDateiname(dg.dateiName);
      await this.deps.schritt?.({ art: 'ausgefuehrt', aktion: 'datei_holen:gespeichert', params: { name, groesse: dg.groesse, sha256: dg.sha256, key: dg.key, blockweise: true }, beschreibung: `Datei von ${this.deps.name} übernommen (blockweise): ${name} (${dg.groesse ?? '?'} B)`, ergebnis: dg.key, autonomie: def.autonomie });
      return { success: true, data: { geraet: this.deps.name, name, groesse: dg.groesse, key: dg.key }, display: `Datei von ${this.deps.name} geholt (blockweise, ${dg.groesse ?? '?'} B): ${name}, gespeichert als key="${dg.key}". Zu groß für einen Chat-Anhang — über den Dateispeicher erreichbar.` };
    }
    // v1235 — datei_holen: Prüfsumme prüfen, im Dateispeicher ablegen, als Anhang zum Owner
    const dh = r.data as { dateiBase64?: string; dateiName?: string; sha256?: string } | undefined;
    if (aktion === 'datei_holen' && dh && typeof dh.dateiBase64 === 'string') {
      const data = Buffer.from(dh.dateiBase64, 'base64');
      if (dh.sha256 && sha256Hex(data) !== dh.sha256) return { success: false, error: 'Prüfsumme der geholten Datei stimmt nicht' };
      const name = sichererDateiname(dh.dateiName);
      let key: string | undefined;
      try { key = await this.deps.dateien?.speichere(name, data); } catch { key = undefined; }
      await this.deps.schritt?.({ art: 'ausgefuehrt', aktion: 'datei_holen:gespeichert', params: { name, groesse: data.length, sha256: dh.sha256 ?? sha256Hex(data), key }, beschreibung: `Datei von ${this.deps.name} übernommen: ${name} (${data.length} B)`, ergebnis: key ?? 'nur als Anhang', autonomie: def.autonomie });
      return { success: true, data: { geraet: this.deps.name, name, groesse: data.length, key }, display: `Datei von ${this.deps.name} geholt: ${name} (${data.length} B)${key ? `, gespeichert als key="${key}"` : ''} — als Anhang zugestellt.`, attachments: [{ fileName: name, mimeType: mimeAusName(name), data }] };
    }
    // v1229 — Screenshots vom Gerät kommen als Bild zum Owner
    const d = r.data as { screenshotBase64?: string; mimeType?: string } | undefined;
    if (d && typeof d.screenshotBase64 === 'string') {
      const dateiName = aktion === 'bildschirm' ? `bildschirm-${this.deps.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg` : 'screenshot.jpg'; // v1268
      return { success: true, data: { geraet: this.deps.name, aktion, breite: (d as { breite?: number }).breite, hoehe: (d as { hoehe?: number }).hoehe, titel: (d as { titel?: string }).titel }, display: `${r.display ?? 'Screenshot'} — das Bild siehst du gleich; beschreibe, was darauf zu sehen ist, wenn der Owner danach gefragt hat.`, attachments: [{ fileName: dateiName, mimeType: d.mimeType ?? 'image/jpeg', data: Buffer.from(d.screenshotBase64, 'base64') }] };
    }
    return { success: true, data: r.data, display: r.display ?? `${beschreibung} — ausgeführt (${r.dauerMs} ms)` };
  }
}
