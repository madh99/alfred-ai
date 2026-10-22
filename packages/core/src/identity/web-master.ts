/**
 * v1598 — Realfall 22.10.: Die Web-Anmeldung („admin“) kannte ihren Master nicht, Vorhaben/Wartung/Tresor zeigten dem Owner
 * „Nur für den Owner“. Ein Web-Benutzer (alfred_users) hängt über Plattform-Verknüpfungen an Einträgen in `users`; deren
 * Master ist der Master der Anmeldung — aber nur, wenn er eindeutig ist. Web-Platzhalter (`web-…`) zählen nicht.
 */
export async function webMasterAus(
  links: Array<{ platform: string; platformUserId: string }>,
  finde: (platform: string, platformUserId: string) => Promise<{ id: string; masterUserId?: string } | undefined>,
): Promise<string | undefined> {
  const master = new Set<string>();
  for (const l of links) {
    if (l.platformUserId.startsWith('web-')) continue;
    const u = await finde(l.platform, l.platformUserId).catch(() => undefined);
    if (u) master.add(u.masterUserId ?? u.id);
  }
  return master.size === 1 ? [...master][0] : undefined;
}
