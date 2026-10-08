/**
 * v1315 — Reparatur-Aktionen dürfen nicht an der Akzeptanzrate einer Kategorie scheitern.
 *
 * Realfall 07.10. 22:31: Alfred schlug „Kalender-Token für fam@dohnal.co erneuern (AADSTS700082)" vor
 * (email/reauthorize, Autonomie bestätigen) und verwarf den Vorgang eine Sekunde später selbst, weil die
 * Akzeptanzrate für email bei 11 % lag (Schwelle 20 %). Der Owner sah den Vorschlag nie; der Kalender blieb tot.
 * Eine Aktion, die einen bekannten Ausfall behebt, ist kein Vorschlag ins Blaue — sie bleibt sichtbar.
 */
export const REPARATUR_AKTIONEN = new Set(['reauthorize', 'reconnect', 'renew_token', 'refresh_token', 'reauth']);

export function istReparaturAktion(skillParams: Record<string, unknown> | undefined): boolean {
  const a = skillParams?.['action'];
  return typeof a === 'string' && REPARATUR_AKTIONEN.has(a.toLowerCase());
}
