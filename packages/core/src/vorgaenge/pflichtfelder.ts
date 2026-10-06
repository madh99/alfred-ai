/**
 * v1216 — Pflichtfelder deterministisch ergänzen, bevor eine Auto-Aktion läuft.
 *
 * Realfall 05.10.: „Erinnerung für Sensor-Batterie-Tausch setzen" scheiterte an fehlendem
 * `message`, „Watch für günstige Strompreise erstellen" zweimal an fehlendem `name` — die
 * Beschreibung der Aktion enthielt den Text längst. Statt eines zweiten Modellaufrufs
 * (Self-Heal) wird das Offensichtliche ergänzt; alles andere bleibt unverändert.
 */
export interface AktionMitParams { skillName: string; skillParams?: Record<string, unknown>; description: string }

export function ergaenzePflichtfelder<T extends AktionMitParams>(action: T): { action: T; ergaenzt: string[] } {
  const ergaenzt: string[] = [];
  const params: Record<string, unknown> = { ...(action.skillParams ?? {}) };
  const beschreibung = (action.description ?? '').trim();
  if (!beschreibung) return { action, ergaenzt };
  const akt = typeof params.action === 'string' ? params.action : undefined;
  const kurz = beschreibung.replace(/\s+/g, ' ').slice(0, 120);
  const fehlt = (k: string) => params[k] === undefined || params[k] === null || (typeof params[k] === 'string' && !(params[k] as string).trim());

  if (action.skillName === 'reminder' && (akt === undefined || akt === 'set') && fehlt('message')) {
    params.message = kurz; ergaenzt.push('message');
  }
  if (action.skillName === 'watch' && (akt === undefined || akt === 'create') && fehlt('name')) {
    params.name = kurz.slice(0, 80); ergaenzt.push('name');
  }
  if (action.skillName === 'todo' && (akt === undefined || akt === 'add' || akt === 'create') && fehlt('title') && fehlt('text')) {
    params.title = kurz.slice(0, 120); ergaenzt.push('title');
  }
  if (action.skillName === 'memory' && (akt === undefined || akt === 'save' || akt === 'store') && fehlt('value') && fehlt('text')) {
    params.value = beschreibung.slice(0, 500); ergaenzt.push('value');
  }
  if (ergaenzt.length === 0) return { action, ergaenzt };
  return { action: { ...action, skillParams: params }, ergaenzt };
}
