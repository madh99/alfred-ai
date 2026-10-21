/**
 * v1550 (Owner 22.10. „S4 … er soll überlegen, was für die aktuelle Aufgabenstellung die bessere Wahl ist, Skill oder SSH“, inkl. d).
 *
 * Alfred wählt selbst zwischen Fachskill und Fernzugriff (SSH). Damit er abwägen kann, sorgen feste Regeln dafür, dass er beide Wege
 * kennt und sieht: (a) nennt eine Nachricht einen Host mit Fernzugang, sind die Infrastruktur-Werkzeuge dabei (Skill-Filter);
 * (c) jedes Ergebnis nennt den jeweils anderen Weg zum selben Host; (d) hat in einer Antwort ein Weg versagt und der andere geholfen,
 * merkt Alfred sich das als Erfahrung für ähnliche Aufgaben. (b) — die Abwägungshilfe — steht in den Skill-Beschreibungen.
 */

/** Fachskills mit eigener Sicht auf Hosts, und was sie zusätzlich zu SSH können. */
export const FACHSKILL_FAEHIGKEITEN: Record<string, string> = {
  proxmox: 'Proxmox-Skill: VM-/Container-Status clusterweit, Backups aller Speicher (backups_vm), Snapshots, Tasks, Knoten-Auslastung',
  homeassistant: 'Home-Assistant-Skill: Zustände und Verlauf von Geräten/Sensoren, Automationen, Dienste aufrufen',
  docker: 'Docker-Skill: Container über die Docker-API (Status, Logs, Neustart mit Bestätigung)',
  unifi: 'UniFi-Skill: Netzwerkgeräte, WLAN-Clients, Firewall-Regeln, System-Log des Gateways',
  mikrotik: 'MikroTik-Skill: Router-Status, Schnittstellen, DHCP, Firewall, Traffic',
  commvault: 'Commvault-Skill: Sicherungsjobs, Schutzstatus der VMs, Speicher, Alarme',
};

/** Abwägungshilfe (b) — kurz, für die Skill-Beschreibungen. */
export const ABWAEGUNG = 'Skill oder SSH abwägen: Fachskill eher für Überblick über mehrere Hosts, strukturierte Daten (Status, Zahlen, Verlauf) und saubere API-Aktionen; '
  + 'Fernzugriff (SSH) eher, wenn die Antwort nur auf dem Host liegt (Logs, Konfigdateien, Kernel, Hardware, ZFS-Details), der Skill die Funktion nicht hat, '
  + 'fehlschlägt oder Widersprüchliches meldet, und für Ursachen („warum“) statt Zustand („was“). Oft beides: erst Überblick per Skill, dann Ursache per SSH.';

/** (c) Hinweis im Fernzugriff-Ergebnis: was die Fachskills zum selben Host zusätzlich können. */
export function fachskillHinweis(hostName: string, skills: string[]): string | undefined {
  const texte = [...new Set(skills)].map(s => FACHSKILL_FAEHIGKEITEN[s]).filter((t): t is string => !!t);
  if (!texte.length) return undefined;
  return `ℹ️ Für ${hostName} gibt es auch: ${texte.join('; ')}. Abwägen, was für die Aufgabe besser ist.`;
}

/** (c) Hinweis im Ergebnis eines Fachskills: es gibt Fernzugänge für Ursachen auf Host-Ebene. */
export function fernzugangHinweis(zugaenge: string[]): string | undefined {
  if (!zugaenge.length) return undefined;
  return `ℹ️ Für Ursachen auf Host-Ebene (Logs, Konfigdateien, Hardware, Kernel) besteht Fernzugang: ${zugaenge.slice(0, 12).join(', ')} (fernzugriff, action=lesen, ohne Rückfrage). Abwägen, ob das weiterhilft.`;
}

/** (a) Muster für Host-Namen der Fernzugänge (ganze Wörter, ohne Groß/Klein); kurze Namen unter 3 Zeichen zählen nicht. */
export function namenMuster(namen: string[]): RegExp | undefined {
  const n = [...new Set(namen.map(x => x.trim()).filter(x => x.length >= 3))].map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_]/g, '[-_ ]?'));
  return n.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${n.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : undefined;
}

export interface WerkzeugAufruf { name: string; input: Record<string, unknown>; isError: boolean; inhalt: string }

/** Ergebnis eines Fachskills, das inhaltlich nichts liefert (kein Fehler, aber auch keine Antwort). */
const LEER = /nicht (verfügbar|unterstützt|gefunden|konfiguriert|möglich)|not (found|supported|available|configured)|keine (daten|einträge|ergebnisse|informationen)|unknown action|unbekannte aktion|no data/i;
/** Fernzugriff-Ergebnisse, die kein Versagen des Weges sind (Rückfrage, Geheimnis, gespeicherte Seite). */
const KEIN_VERSAGEN = /zur Bestätigung|berührt .* — das läuft nur mit Bestätigung|nie erlaubt/;

const kurz = (t: string, n: number) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const beschreibe = (a: WerkzeugAufruf) => a.name === 'fernzugriff'
  ? `fernzugriff lesen \`${kurz(String(a.input.befehl ?? ''), 100)}\` auf ${String(a.input.name ?? '?')}`
  : `${a.name}${typeof a.input.action === 'string' ? `.${a.input.action}` : ''}`;

/**
 * (d) Weg-Erfahrungen einer Antwort: hat ein Fachskill versagt (Fehler oder leer) und danach der Fernzugriff geliefert — oder
 * umgekehrt —, entsteht je Paar eine Erfahrung. Schlüssel stabil je Weg-Paar, damit spätere Fälle sie überschreiben statt zu häufen.
 */
export function wegErfahrungen(aufrufe: WerkzeugAufruf[], frage: string): Array<{ key: string; text: string }> {
  const aus: Array<{ key: string; text: string }> = [];
  const istFach = (a: WerkzeugAufruf) => a.name in FACHSKILL_FAEHIGKEITEN;
  const versagt = (a: WerkzeugAufruf) => a.name === 'fernzugriff'
    ? a.isError && !KEIN_VERSAGEN.test(a.inhalt) && String(a.input.action ?? '') === 'lesen'
    : a.isError || LEER.test(a.inhalt.slice(0, 600));
  const geliefert = (a: WerkzeugAufruf) => !a.isError && !(a.name !== 'fernzugriff' && LEER.test(a.inhalt.slice(0, 600))) && !/zur Bestätigung an den Owner gestellt/.test(a.inhalt)
    && (a.name !== 'fernzugriff' || String(a.input.action ?? '') === 'lesen');
  for (let i = 0; i < aufrufe.length; i++) {
    const a = aufrufe[i]!;
    if (!versagt(a)) continue;
    const andererWeg = (b: WerkzeugAufruf) => (istFach(a) ? b.name === 'fernzugriff' : istFach(b));
    const b = aufrufe.slice(i + 1).find(x => andererWeg(x) && geliefert(x));
    if (!b) continue;
    const key = `weg:${a.name}${typeof a.input.action === 'string' ? `.${a.input.action}` : ''}→${b.name}${b.name === 'fernzugriff' ? `:${String(b.input.befehl ?? '').split(/\s+/)[0]}` : typeof b.input.action === 'string' ? `.${b.input.action}` : ''}`;
    if (aus.some(x => x.key === key)) continue;
    aus.push({
      key: key.slice(0, 120),
      text: `Weg-Erfahrung (Skill oder SSH): Bei „${kurz(frage, 140)}“ half ${beschreibe(a)} nicht (${kurz(a.inhalt, 140)}); ${beschreibe(b)} lieferte die Antwort. Bei ähnlichen Aufgaben diesen Weg früher in Betracht ziehen.`,
    });
  }
  return aus.slice(0, 3);
}
