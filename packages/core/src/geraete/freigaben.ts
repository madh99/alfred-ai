import { createHash, randomUUID } from 'node:crypto';

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
