/**
 * v1428 — Objekt-Hinweise (Spec „Vom Signal zur Handlung", V1; Owner 13.10. „einverstanden wie empfohlen"):
 * Ein Hinweis, der einen offenen Vorgang betrifft, übernimmt dessen Identität und wird nur bei einem Zustandswechsel
 * zugestellt (neu, geändert, Frist < 24 h). Freie Information (Interessen, Vorausschau, Strompreis …) ist nicht betroffen.
 * Rein deterministisch; Realfall 11.–13.10.: Domains noahhabel 6×, Proxmox-Replikation 4× an einem Tag.
 */
import { ankerAus, inhaltsWoerter } from './hinweis-pruefung.js';

export interface HinweisObjekt {
  art: 'vorgang';
  id: string;
  titel: string;
  /** Ziel/Lage des Vorgangs (für Anker wie Domain, Datum, Kennung) */
  text?: string;
  /** Zustand, dessen Änderung einen neuen Hinweis rechtfertigt (Status, nächster Schritt, Besitzer) */
  signatur: string;
  frist?: string;
}

export interface ObjektTreffer { objekt: HinweisObjekt; gemeinsam: number; anteil: number; anker: number }

/** Wortstamm grob: lange Wörter auf 7 Zeichen (Replikation ~ Replikationsstatus, verlängern ~ Verlängerung). */
const stamm = (w: string) => (w.length >= 8 ? w.slice(0, 7) : w);
const staemme = (s: string) => new Set([...inhaltsWoerter(s)].map(stamm));
const schnitt = (x: Set<string>, y: Set<string>) => { let n = 0; for (const v of x) if (y.has(v)) n++; return n; };

/**
 * Betrifft dieser Hinweis-Punkt einen der Vorgänge? Maßstab sind die Titelwörter des Vorgangs (ein Titel nennt den
 * Gegenstand), gestützt durch gemeinsame Anker aus Titel + Ziel. Im Zweifel kein Treffer — dann wird zugestellt wie bisher.
 */
export function objektTreffer(punkt: string, objekte: HinweisObjekt[]): ObjektTreffer | null {
  const wp = staemme(punkt);
  if (wp.size === 0) return null;
  const ap = ankerAus(punkt);
  let best: ObjektTreffer | null = null;
  for (const o of objekte) {
    const wt = staemme(o.titel);
    if (wt.size === 0) continue;
    const gemeinsam = schnitt(wp, wt);
    const anteil = gemeinsam / wt.size;
    const anker = schnitt(ap, ankerAus(`${o.titel}\n${o.text ?? ''}`));
    const treffer = (gemeinsam >= 2 && anteil >= 0.5) || (anker >= 1 && gemeinsam >= 2 && anteil >= 0.34) || (anker >= 2 && gemeinsam >= 1);
    if (treffer && (!best || anteil + anker * 0.1 > best.anteil + best.anker * 0.1)) best = { objekt: o, gemeinsam, anteil, anker };
  }
  return best;
}

export type ObjektWechsel = 'neu' | 'geaendert' | 'frist';

/** Darf zu diesem Objekt jetzt ein Hinweis kommen? null = nein (schon gemeldet, nichts geändert). */
export function objektWechsel(o: HinweisObjekt, letzte: { signatur: string; frist?: boolean } | undefined, jetzt = Date.now()): ObjektWechsel | null {
  if (!letzte) return 'neu';
  if (letzte.signatur !== o.signatur) return 'geaendert';
  const f = o.frist ? Date.parse(o.frist) : NaN;
  if (Number.isFinite(f) && f - jetzt <= 24 * 3_600_000 && f > jetzt - 24 * 3_600_000 && !letzte.frist) return 'frist';
  return null;
}

export function vorgangSignatur(v: { status: string; naechsterSchritt?: string; besitzer?: string }): string {
  return `${v.status}|${(v.naechsterSchritt ?? '').trim().toLowerCase()}|${v.besitzer ?? ''}`;
}
