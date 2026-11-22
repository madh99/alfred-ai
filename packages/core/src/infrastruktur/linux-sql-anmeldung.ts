/**
 * I8e Folge-Etappe (Spec docs/specs/2026-11-22-i8e-alfred-logins-sa.md §7.2) — zentrale, deterministische Wahl des SQL-Logins für die
 * Linux-SQL-Bausteine:
 * - Fehlen beide Alfred-Einträge im Tresor, gilt weiter `sa` (Übergang bis `alfred_logins_anlegen`).
 * - Sobald EINER existiert, ist der Zugang umgestellt: beide sind Pflicht, `aendern` → alfred_admin, `lesen` → alfred_status,
 *   `sa` wird für diesen Zugang nie mehr benutzt (kein Rückfall). Die Host-Marke SA_SPERRE sperrt `sa` zusätzlich auf dem Host.
 */
export const ADMIN_LOGIN = 'alfred_admin';
export const STATUS_LOGIN = 'alfred_status';
export type SqlLogin = 'sa' | typeof ADMIN_LOGIN | typeof STATUS_LOGIN;
export type AnmeldeArt = 'lesen' | 'aendern';

export const saName = (zugang: string) => `sqllnx-${zugang.toLowerCase()}-sa`;
export const alfredLoginTresor = (zugang: string, login: typeof ADMIN_LOGIN | typeof STATUS_LOGIN) =>
  `sqllnx-${zugang.toLowerCase()}-${login.replace('_', '-')}`;

export function waehleAnmeldung(namen: Set<string>, zugang: string, art: AnmeldeArt): { login: SqlLogin; tresor: string } {
  const adm = alfredLoginTresor(zugang, ADMIN_LOGIN);
  const sta = alfredLoginTresor(zugang, STATUS_LOGIN);
  if (namen.has(adm) || namen.has(sta)) {
    for (const n of [adm, sta]) {
      if (!namen.has(n)) throw new Error(`Tresor-Eintrag ${n} fehlt — ${zugang} ist auf Alfred-Logins umgestellt, kein Rückfall auf sa; nichts geändert`);
    }
    return art === 'aendern' ? { login: ADMIN_LOGIN, tresor: adm } : { login: STATUS_LOGIN, tresor: sta };
  }
  const sa = saName(zugang);
  if (!namen.has(sa)) throw new Error(`Tresor-Eintrag ${sa} fehlt — zuerst linux_sql installieren`);
  return { login: 'sa', tresor: sa };
}

export async function sqlAnmeldung(
  t: { namen(): Promise<Set<string>>; lies(n: string, wofuer: string): Promise<string> },
  zugang: string, art: AnmeldeArt, wofuer: string, geheim: string[],
): Promise<{ login: SqlLogin; kennwort: string; eingabe: { sa: string; login: SqlLogin } }> {
  const w = waehleAnmeldung(await t.namen(), zugang, art);
  const kennwort = await t.lies(w.tresor, `${wofuer} (als ${w.login})`);
  geheim.push(kennwort);
  return { login: w.login, kennwort, eingabe: { sa: kennwort, login: w.login } };
}
