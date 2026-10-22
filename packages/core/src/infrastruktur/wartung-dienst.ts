/**
 * I4b Teil 1 — Wartungsfenster, Sperrzeiten und Benachrichtigungen im Ablauf des Ausführungsmotors.
 * Der Motor fragt vor jedem Start `zeitplan`: Fenster offen, keine Sperre, und — wenn eine Regel „24 h/1 h vorher“ verlangt —
 * ist der Start angekündigt und die Vorlaufzeit verstrichen? Fällige Ankündigungen gehen dabei genau einmal hinaus.
 */
import type { CmdbChangeRequest } from '@alfred/types';
import { faelligeBenachrichtigungen, giltFuer, regelnFuerEreignis, startPruefen, type BenachrichtigungsRegel, type Empfaenger, type KalenderEintrag, type Kanal, type Zeitpunkt } from './wartung.js';

export interface WartungsDeps {
  kalender: (o: string) => Promise<KalenderEintrag[]>;
  regeln: (o: string) => Promise<BenachrichtigungsRegel[]>;
  setzeAnkuendigung: (o: string, id: string, a: { start?: string; gesendet: string[] }) => Promise<void>;
  /** Zustellung je Empfänger und Kanal; false = auf diesem Weg nicht zustellbar */
  sende: (e: Empfaenger, kanal: Kanal, titel: string, text: string) => Promise<boolean>;
  jetzt?: () => number;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

const VORLAUF: Partial<Record<Zeitpunkt, number>> = { '24h_vorher': 24 * 3_600_000, '1h_vorher': 3_600_000 };
const wien = (t: number) => new Date(t).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export class WartungsDienst {
  constructor(private readonly d: WartungsDeps) {}
  private jetzt(): number { return this.d.jetzt?.() ?? Date.now(); }

  /** Darf der Change jetzt starten? Legt bei Ankündigungspflicht den Start fest und verschickt fällige Ankündigungen. */
  async zeitplan(o: string, c: CmdbChangeRequest): Promise<{ jetzt: boolean; grund: string; startAb?: string }> {
    const jetzt = this.jetzt();
    const [eintraege, regeln] = await Promise.all([this.d.kalender(o), this.d.regeln(o)]);
    const basis = { notfall: c.type === 'emergency', assetIds: c.affectedAssetIds, serviceIds: c.affectedServiceIds, ...(c.ausfallMinuten !== undefined ? { ausfallMinuten: c.ausfallMinuten } : {}) };
    const sp = startPruefen(basis, eintraege, jetzt);
    if (basis.notfall) return { jetzt: true, grund: 'Notfall-Change' };
    const vorlauf = Math.max(0, ...regeln.filter(r => r.aktiv && giltFuer(r.geltung, c.affectedAssetIds, c.affectedServiceIds)).flatMap(r => r.zeitpunkte.map(z => VORLAUF[z] ?? 0)));
    if (!vorlauf) return { jetzt: sp.erlaubt, grund: sp.grund, ...(sp.naechsterStart ? { startAb: new Date(sp.naechsterStart).toISOString() } : {}) };

    let ank = c.ankuendigung ?? { gesendet: [] };
    let start = ank.start ? Date.parse(ank.start) : undefined;
    // Neuer Termin: erstmals, oder der angekündigte Termin ist da, aber nicht (mehr) erlaubt (Fenster/Sperre geändert)
    if (start === undefined || (jetzt >= start && !sp.erlaubt)) {
      const t0 = Math.max(jetzt + vorlauf, c.scheduledAt ? Date.parse(c.scheduledAt) : 0);
      const p = startPruefen(basis, eintraege, t0);
      const neu = p.erlaubt ? t0 : p.naechsterStart;
      if (neu === undefined) return { jetzt: false, grund: 'kein möglicher Termin in den nächsten 35 Tagen (Fenster/Sperren prüfen)' };
      start = neu;
      ank = { start: new Date(start).toISOString(), gesendet: ank.gesendet };
      await this.d.setzeAnkuendigung(o, c.id, ank);
      this.d.protokoll?.('I4b Change-Start angekündigt', { id: c.id, start: ank.start, vorlaufMin: Math.round(vorlauf / 60_000) });
    }
    const faellig = faelligeBenachrichtigungen({ id: c.id, assetIds: c.affectedAssetIds, serviceIds: c.affectedServiceIds, startGeplant: start }, regeln, jetzt, new Set(ank.gesendet));
    for (const f of faellig) {
      const text = `Geplante Wartung: ${c.title}\nBeginn ${wien(start)}${c.ausfallMinuten ? `, erwartete Unterbrechung bis ${c.ausfallMinuten} min` : ''}.`;
      const zugestellt = await this.verteile(f.regel, `Wartung ${f.zeitpunkt === '24h_vorher' ? 'morgen' : 'in 1 Stunde'}`, text);
      ank = { ...ank, gesendet: [...ank.gesendet, f.schluessel] };
      await this.d.setzeAnkuendigung(o, c.id, ank);
      this.d.protokoll?.('I4b Ankündigung', { id: c.id, regel: f.regel.name, zeitpunkt: f.zeitpunkt, zugestellt });
    }
    if (jetzt >= start) return { jetzt: sp.erlaubt, grund: sp.erlaubt ? `angekündigt für ${wien(start)}` : sp.grund };
    return { jetzt: false, grund: `angekündigt für ${wien(start)}`, startAb: new Date(start).toISOString() };
  }

  /** Start, Ende oder Störung an alle Empfänger der passenden Regeln. */
  async ereignis(o: string, c: CmdbChangeRequest, z: 'start' | 'ende' | 'stoerung', text: string): Promise<void> {
    const regeln = regelnFuerEreignis({ assetIds: c.affectedAssetIds, serviceIds: c.affectedServiceIds }, await this.d.regeln(o), z);
    for (const r of regeln) {
      const n = await this.verteile(r, z === 'start' ? `Wartung beginnt: ${c.title}` : z === 'ende' ? `Wartung beendet: ${c.title}` : `Störung bei Wartung: ${c.title}`, text);
      this.d.protokoll?.('I4b Benachrichtigung', { id: c.id, regel: r.name, ereignis: z, zugestellt: n });
    }
  }

  /** Jede Person der Regel über jeden ihrer Kanäle; zählt erfolgreiche Zustellungen. */
  private async verteile(r: BenachrichtigungsRegel, titel: string, text: string): Promise<number> {
    let n = 0;
    for (const e of r.empfaenger) for (const k of r.kanaele) if (await this.d.sende(e, k, titel, text).catch(() => false)) n++;
    return n;
  }
}

/** Ist ein Empfänger über mindestens einen der Kanäle erreichbar (für die Prüfung beim Anlegen)? */
export function erreichbar(e: Empfaenger, kanaele: Kanal[]): boolean {
  return kanaele.some(k => (k === 'push' && e.art === 'owner') || (k === 'telegram' && (e.art === 'owner' || !!e.telegramId || !!e.konten?.telegram)) || (k === 'matrix' && !!e.konten?.matrix) || (k === 'email' && !!e.email) || (k === 'homeassistant' && !!e.haDienst));
}
