/**
 * I8e — Register der Linux-Bausteinskripte. `FernzugriffSkill.linuxSkript` führt nur Skripte aus, die ein hier beim Laden eines
 * Baustein-Moduls registrierter Erzeuger aus typisierten Parametern baut — nie freien Text (Modell, Eingabe, Netz).
 * Nach der ersten Verwendung ist das Register eingefroren; jeder Schlüssel lässt sich genau einmal registrieren.
 *
 * Konvention für Bausteinskripte: Der feste Kopf in linuxSkript liest die erste Zeile der Standardeingabe in die (nicht exportierte)
 * Shell-Variable ALFRED_EINGABE und hängt stdin danach auf /dev/null um — kein Kindprozess kann die Eingabe lesen. Ein Baustein
 * verwendet seine Eingabe (meist JSON in einer Zeile) also nur über "$ALFRED_EINGABE" und reicht sie gezielt per Here-String weiter.
 */
export type LinuxBausteinErzeuger<P = Record<string, unknown>> = (parameter: P) => string;

const register = new Map<string, LinuxBausteinErzeuger<never>>();
let eingefroren = false;

const SCHLUESSEL = /^[a-z][a-z0-9_.-]{1,63}$/;

export function registriereLinuxBaustein<P>(schluessel: string, erzeuger: LinuxBausteinErzeuger<P>): void {
  if (eingefroren) throw new Error(`Linux-Baustein „${schluessel}“: Register ist nach der ersten Verwendung eingefroren`);
  if (!SCHLUESSEL.test(schluessel)) throw new Error(`Linux-Baustein: ungültiger Schlüssel „${schluessel}“`);
  if (register.has(schluessel)) throw new Error(`Linux-Baustein „${schluessel}“ ist schon registriert`);
  if (typeof erzeuger !== 'function') throw new Error(`Linux-Baustein „${schluessel}“: Erzeuger fehlt`);
  register.set(schluessel, erzeuger as LinuxBausteinErzeuger<never>);
}

/** Skripttext eines registrierten Bausteins; friert das Register ein. Unbekannter Schlüssel oder leeres Ergebnis → Fehler. */
export function linuxBausteinSkript(schluessel: string, parameter: unknown): string {
  eingefroren = true;
  const e = register.get(schluessel);
  if (!e) throw new Error(`Unbekannter Linux-Baustein „${schluessel}“`);
  const skript = (e as LinuxBausteinErzeuger<unknown>)(parameter);
  if (typeof skript !== 'string' || !skript.trim()) throw new Error(`Linux-Baustein „${schluessel}“ lieferte kein Skript`);
  return skript;
}

export function linuxBausteinBekannt(schluessel: string): boolean { return register.has(schluessel); }
