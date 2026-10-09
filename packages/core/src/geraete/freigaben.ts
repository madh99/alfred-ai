import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * v1225 — Einmal-Freigaben für Geräteaktionen der Klasse `bestaetigen`.
 *
 * Sicherheitsbefund zu .1224: Die Bestätigung wurde über einen Parameter `confirmed: true`
 * transportiert, den auch das Modell in einen Tool-Aufruf hätte schreiben können — ein Umweg
 * um die Owner-Bestätigung. Jetzt erzeugt das Gehirn beim Einreihen eine zufällige Freigabe,
 * gebunden an Skill, Aktion und Parameter, einmal verwendbar, 60 Minuten gültig. Nur die
 * Bestätigungs-Queue kennt sie; das Modell kann sie nicht erraten oder erfinden.
 */
export const FREIGABE_GUELTIG_MS = 60 * 60_000;

export function paramsFingerabdruck(params: Record<string, unknown>): string {
  const rein: Record<string, unknown> = {};
  for (const k of Object.keys(params).sort()) if (k !== 'freigabe' && k !== 'confirmed') rein[k] = params[k];
  return createHash('sha256').update(JSON.stringify(rein)).digest('hex');
}

export class Freigaben {
  private readonly offen = new Map<string, { skillName: string; aktion: string; fingerabdruck: string; bis: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  erzeuge(skillName: string, aktion: string, params: Record<string, unknown>): string {
    this.raeumeAuf();
    const nonce = randomUUID();
    this.offen.set(nonce, { skillName, aktion, fingerabdruck: paramsFingerabdruck(params), bis: this.now() + FREIGABE_GUELTIG_MS });
    return nonce;
  }

  /** Prüft und verbraucht eine Freigabe. Falsche Aktion oder veränderte Parameter → ungültig. */
  verbrauche(nonce: unknown, skillName: string, aktion: string, params: Record<string, unknown>): boolean {
    if (typeof nonce !== 'string') return false;
    const f = this.offen.get(nonce);
    if (!f) return false;
    this.offen.delete(nonce);
    if (f.bis < this.now()) return false;
    return f.skillName === skillName && f.aktion === aktion && f.fingerabdruck === paramsFingerabdruck(params);
  }

  anzahl(): number { this.raeumeAuf(); return this.offen.size; }

  private raeumeAuf(): void {
    const jetzt = this.now();
    for (const [k, f] of this.offen) if (f.bis < jetzt) this.offen.delete(k);
  }
}

/**
 * v1230 — Vorhaben-Freigabe (Owner-Wunsch 06.10.): Der Owner sagt EINMAL ja zu einem Vorhaben mit
 * Umfang (Gerät, erlaubte Aktionen, Domains, Dauer); danach laufen die genannten Aktionen ohne
 * Einzelbestätigung. Was im Manifest oder in den Browser-Regeln `nie` ist, bleibt gesperrt —
 * ein Vorhaben kann nur Bestätigungen ersetzen, nie Sperren aufheben.
 */
export const VORHABEN_MAX_MIN = 120;
export const VORHABEN_GNADENFRIST_MS = 5 * 60_000; // v1297

/**
 * v1295 — Bedienen günstiger (Owner-Freigabe 08.10.): Die Schritte eines freigegebenen Vorhabens (Fenster lesen, klicken,
 * tippen, Foto) brauchen kein Planungsmodell — das Standardmodell hat geplant und die Owner-Frage formuliert. Die
 * Fortsetzung läuft auf dem Tier `fast` (nur mit dem Geräte-Werkzeug, s. v1231); Messung 08.10.: default ≈ 0,10 $ je
 * Runde bei ~50k Prompt-Tokens, fast ≈ 0,003 $. Kein Modell-Gate: fällt das Tier aus, greift die normale Fallback-Kette
 * des Routers. Über ALFRED_GERAETE_VORHABEN_TIER umstellbar (default|medium|strong|fast|fallback); Unsinn → fast.
 */
export const VORHABEN_TIER_STANDARD = 'fast';
export function vorhabenTier(env: Record<string, string | undefined> = process.env): 'default' | 'medium' | 'strong' | 'fast' | 'fallback' {
  const w = (env.ALFRED_GERAETE_VORHABEN_TIER ?? '').trim().toLowerCase();
  return w === 'default' || w === 'medium' || w === 'strong' || w === 'fast' || w === 'fallback' ? w : VORHABEN_TIER_STANDARD;
}

export interface Vorhaben {
  nonce: string;
  skillName: string;
  beschreibung: string;
  aktionen: string[];
  domains: string[];
  bis: number;
  aktiv: boolean;
  schritte: number;
  /** v1324 — Chat, aus dem das Vorhaben angefordert wurde (Gerätesitzung): die Fortsetzung läuft dort, nicht nur im Owner-Chat. */
  herkunft?: VorhabenHerkunft;
}

export interface VorhabenHerkunft { chatId: string; platform: string; userId: string }

export function hostAus(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase(); } catch { return undefined; }
}

export function domainErlaubt(host: string | undefined, domains: string[]): boolean {
  if (domains.length === 0) return true;
  if (!host) return false;
  return domains.some(d => { const dd = d.toLowerCase().replace(/^\*\./, ''); return host === dd || host.endsWith('.' + dd); });
}

/** v1240 — Ablage der Vorhaben (Datei im Datenordner): ein Neustart darf ein freigegebenes Vorhaben nicht vergessen. */
export interface VorhabenSpeicher { lade(): Vorhaben[]; speichere(v: Vorhaben[]): void }

export class VorhabenFreigaben {
  private readonly vorhaben = new Map<string, Vorhaben>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly speicher?: VorhabenSpeicher) {
    if (speicher) {
      try { for (const v of speicher.lade()) if (v && typeof v.nonce === 'string' && v.bis > this.now()) this.vorhaben.set(v.nonce, v); } catch { /* leer starten */ }
    }
  }

  private sichere(): void {
    if (!this.speicher) return;
    try { this.speicher.speichere([...this.vorhaben.values()]); } catch { /* Ablage optional */ }
  }

  erzeuge(skillName: string, v: { beschreibung: string; aktionen: string[]; domains?: string[]; dauerMin?: number; herkunft?: VorhabenHerkunft }): Vorhaben {
    this.raeumeAuf();
    const dauer = Math.min(Math.max(5, Math.round(v.dauerMin ?? 30)), VORHABEN_MAX_MIN);
    const vorhaben: Vorhaben = {
      nonce: randomUUID(), skillName, beschreibung: v.beschreibung.slice(0, 300),
      aktionen: [...new Set(v.aktionen.map(a => a.trim()).filter(Boolean))].slice(0, 20),
      domains: [...new Set((v.domains ?? []).map(d => d.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
      bis: this.now() + dauer * 60_000, aktiv: false, schritte: 0,
      ...(v.herkunft ? { herkunft: v.herkunft } : {}),
    };
    this.vorhaben.set(vorhaben.nonce, vorhaben);
    this.sichere();
    return vorhaben;
  }

  /** Vom Owner freigegeben (über die Bestätigungs-Queue, deren Parameter die Nonce tragen). */
  aktiviere(nonce: unknown, skillName: string): Vorhaben | undefined {
    if (typeof nonce !== 'string') return undefined;
    const v = this.vorhaben.get(nonce);
    if (!v || v.skillName !== skillName || v.bis < this.now()) return undefined;
    v.aktiv = true;
    this.sichere();
    return v;
  }

  /** Deckt ein aktives Vorhaben diese Aktion? Zählt den Schritt mit. */
  deckt(skillName: string, aktion: string, params: Record<string, unknown>): Vorhaben | undefined {
    this.raeumeAuf();
    for (const v of this.vorhaben.values()) {
      if (!v.aktiv || v.skillName !== skillName) continue;
      if (!v.aktionen.includes(aktion) && !v.aktionen.some(a => a.endsWith('*') && aktion.startsWith(a.slice(0, -1)))) continue;
      const host = hostAus(params.url ?? params.path);
      if (host !== undefined && !domainErlaubt(host, v.domains)) continue;
      v.schritte += 1;
      this.sichere();
      return v;
    }
    return undefined;
  }

  aktive(skillName?: string): Vorhaben[] { this.raeumeAuf(); return [...this.vorhaben.values()].filter(v => v.aktiv && (!skillName || v.skillName === skillName)); }

  beende(nonce: string): void { this.vorhaben.delete(nonce); this.sichere(); }

  /**
   * v1297 — Nach der Fortsetzung ist das Vorhaben erledigt; bis zum Ablauf (bis 120 min) blockierte es Selbstupdate und
   * Ruhephasen (Realfall 08.10.: Server wartete 25 min auf zwei fertige Mac-Vorhaben). Statt sofort zu löschen bleibt
   * eine Gnadenfrist für Nachfragen des Owners („mach weiter"), danach läuft es aus.
   */
  verkuerze(nonce: string, gnadenfristMs = VORHABEN_GNADENFRIST_MS): Vorhaben | undefined {
    const v = this.vorhaben.get(nonce);
    if (!v) return undefined;
    v.bis = Math.min(v.bis, this.now() + gnadenfristMs);
    this.sichere();
    return v;
  }

  private raeumeAuf(): void {
    const jetzt = this.now(); let geaendert = false;
    for (const [k, v] of this.vorhaben) if (v.bis < jetzt) { this.vorhaben.delete(k); geaendert = true; }
    if (geaendert) this.sichere();
  }
}

/** v1240 — Datei-Ablage für Vorhaben (JSON, synchron, klein). */
export function vorhabenDateiSpeicher(pfad: string): VorhabenSpeicher {
  return {
    lade: () => { try { return JSON.parse(readFileSync(pfad, 'utf8')) as Vorhaben[]; } catch { return []; } },
    speichere: (v) => { try { mkdirSync(dirname(pfad), { recursive: true }); writeFileSync(pfad, JSON.stringify(v), { mode: 0o600 }); } catch { /* Ablage optional */ } },
  };
}
