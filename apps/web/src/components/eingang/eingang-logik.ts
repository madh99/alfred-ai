// v1487 — Eingang wie in der App (apps/flutter/lib/eingang.dart): eine Liste für alles, was den Owner braucht.
import type { AufgabeZeile, HinweisZeile, PendingConfirmationItem, VorgangDto } from '@/lib/alfred-client';

export type EingangArt = 'bestaetigung' | 'vorgang' | 'aufgabe' | 'hinweis';

export const ART_NAME: Record<EingangArt, string> = { bestaetigung: 'Bestätigungen', vorgang: 'Vorgänge', aufgabe: 'Aufgaben', hinweis: 'Hinweise' };
export const ART_EINZELN: Record<EingangArt, string> = { bestaetigung: 'Bestätigung', vorgang: 'Vorgang', aufgabe: 'Aufgabe', hinweis: 'Hinweis' };
export const ARTEN: EingangArt[] = ['bestaetigung', 'vorgang', 'aufgabe', 'hinweis'];

export type EingangEintrag =
  | { art: 'bestaetigung'; id: string; titel: string; text?: string; zeit?: Date; rang: number; roh: PendingConfirmationItem }
  | { art: 'vorgang'; id: string; titel: string; text?: string; zeit?: Date; rang: number; roh: VorgangDto }
  | { art: 'aufgabe'; id: string; titel: string; text?: string; zeit?: Date; rang: number; roh: AufgabeZeile }
  | { art: 'hinweis'; id: string; titel: string; text?: string; zeit?: Date; rang: number; roh: HinweisZeile };

function datum(s?: string | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function tag(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

/** Gruppe einer Aufgabe relativ zu jetzt (lokale Zeit), wie aufgabenGruppe in der App */
export function aufgabenGruppe(a: AufgabeZeile, jetzt: Date): string {
  const f = datum(a.faellig);
  if (!f) return 'Ohne Termin';
  const heute = tag(jetzt), t = tag(f);
  if (t < heute) return 'Überfällig';
  if (t === heute) return 'Heute';
  return 'Später';
}

export function aufgabeFaellig(a: AufgabeZeile, jetzt: Date): boolean {
  if (a.erledigt) return false;
  const g = aufgabenGruppe(a, jetzt);
  return g === 'Überfällig' || g === 'Heute';
}

/** Hinweis offen = pending oder snoozed (wie Hinweis.offen in der App) */
export function hinweisOffen(h: HinweisZeile): boolean { return h.status === 'pending' || h.status === 'snoozed'; }

function zurueckgestellt(v: VorgangDto, jetzt: Date): boolean {
  const b = datum(v.zurueckBis);
  return !!b && b.getTime() > jetzt.getTime();
}

/** Vorgänge „für dich": wartend oder beim Owner, nicht zurückgestellt; nach Frist sortiert (vorgangGruppen.fuerDich) */
export function vorgaengeFuerDich(offene: VorgangDto[], jetzt: Date): VorgangDto[] {
  const frist = (v: VorgangDto) => datum(v.frist)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return offene
    .filter(v => !zurueckgestellt(v, jetzt) && (v.status === 'wartet' || v.besitzer === 'user'))
    .sort((a, b) => frist(a) - frist(b));
}

/** Alles, was eine Reaktion braucht: Bestätigungen · wartende Vorgänge/dringende Hinweise · fällige Aufgaben · Vorgänge bei dir · Hinweise */
export function eingangEintraege(p: { bestaetigungen: PendingConfirmationItem[]; vorgaenge: VorgangDto[]; aufgaben: AufgabeZeile[]; hinweise: HinweisZeile[]; jetzt: Date }): EingangEintrag[] {
  const aus: EingangEintrag[] = [
    ...p.bestaetigungen.map((b): EingangEintrag => ({ art: 'bestaetigung', id: b.id, titel: b.description, text: b.skillName, zeit: datum(b.createdAt), rang: 0, roh: b })),
    ...vorgaengeFuerDich(p.vorgaenge, p.jetzt).map((v): EingangEintrag => ({ art: 'vorgang', id: v.id, titel: v.titel, text: v.naechsterSchritt, zeit: datum(v.frist ?? v.erstellt), rang: v.status === 'wartet' ? 1 : 3, roh: v })),
    ...p.aufgaben.filter(a => aufgabeFaellig(a, p.jetzt)).map((a): EingangEintrag => ({ art: 'aufgabe', id: a.id, titel: a.titel, text: aufgabenGruppe(a, p.jetzt), zeit: datum(a.faellig), rang: 2, roh: a })),
    ...p.hinweise.filter(hinweisOffen).map((h): EingangEintrag => ({ art: 'hinweis', id: h.id, titel: h.titel || h.text, text: h.titel ? h.text : undefined, zeit: datum(h.zeit), rang: h.dringlichkeit === 'urgent' ? 1 : 4, roh: h })),
  ];
  return aus.sort((a, b) => {
    if (a.rang !== b.rang) return a.rang - b.rang;
    if (!a.zeit || !b.zeit) return 0;
    // Hinweise: neueste zuerst; sonst älteste/früheste Frist zuerst
    return a.art === 'hinweis' ? b.zeit.getTime() - a.zeit.getTime() : a.zeit.getTime() - b.zeit.getTime();
  });
}
