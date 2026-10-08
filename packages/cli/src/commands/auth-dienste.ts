/**
 * v1315 — Microsoft-Refresh-Tokens liegen an drei Orten: .env, config/default.yml und in der Datenbank
 * (`user_services`: Dienste wie calendar „microsoft", calendar „fam@dohnal.co" mit sharedCalendar, email „outlook", todo, contacts).
 * `alfred auth microsoft` erneuerte bisher nur die ersten beiden (v1284). Realfall 08.10.: der Familienkalender
 * (DB-Dienst, Token-Kopie vom März) blieb mit AADSTS700082 tot, obwohl der Owner den Token am Vortag erneuert hatte.
 *
 * Rein: welche Dienst-Zeilen bekommen den neuen Token? Alle mit `microsoft.clientId` gleich der Client-ID des Flows
 * und abweichendem refreshToken. Andere Schlüssel (sharedCalendar, tenantId …) bleiben unverändert.
 */
export interface DienstZeile { id: string; serviceType: string; serviceName: string; config: string | Record<string, unknown> }
export interface DienstUpdate { id: string; serviceType: string; serviceName: string; config: string }

export function erneuereDienstTokens(zeilen: DienstZeile[], clientId: string, refreshToken: string): DienstUpdate[] {
  const updates: DienstUpdate[] = [];
  for (const z of zeilen) {
    let cfg: Record<string, unknown>;
    try { cfg = typeof z.config === 'string' ? JSON.parse(z.config) as Record<string, unknown> : { ...z.config }; } catch { continue; }
    const ms = cfg['microsoft'] as { clientId?: string; refreshToken?: string } | undefined;
    if (!ms || typeof ms !== 'object' || ms.clientId !== clientId || ms.refreshToken === refreshToken) continue;
    cfg['microsoft'] = { ...ms, refreshToken };
    updates.push({ id: z.id, serviceType: z.serviceType, serviceName: z.serviceName, config: JSON.stringify(cfg) });
  }
  return updates;
}

/** Refresh-Token aus einer .env-Datei (ohne dotenv): erster passender Schlüssel, Anführungszeichen entfernt. */
export function tokenAusEnv(text: string, schluessel = ['ALFRED_MICROSOFT_CALENDAR_REFRESH_TOKEN', 'ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN']): { schluessel: string; token: string } | undefined {
  const zeilen = text.split('\n');
  for (const k of schluessel) {
    const z = zeilen.find(l => l.startsWith(`${k}=`));
    if (!z) continue;
    const wert = z.slice(k.length + 1).trim().replace(/^["']|["']$/g, '').replace(/\r$/, '');
    if (wert) return { schluessel: k, token: wert };
  }
  return undefined;
}
