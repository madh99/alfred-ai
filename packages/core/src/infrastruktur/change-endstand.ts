import type { CmdbChangeRequest } from '@alfred/types';

const STATUS_TEXT: Record<string, string> = {
  draft: 'im Entwurf', submitted: 'eingereicht', approved: 'freigegeben', in_progress: 'läuft',
  completed: 'abgeschlossen', rolled_back: 'zurückgerollt', failed: 'fehlgeschlagen', cancelled: 'abgebrochen',
};

function zeit(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` um ${d.toLocaleTimeString('de-AT', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * v1971 — Endstand der in dieser Runde berührten Changes: eine Zeile je Change, dessen Status sich seit dem Werkzeugaufruf geändert
 * hat. Ist der Stand nicht lesbar, sagt die Zeile das (nichts bleibt stumm). Gleicher Status → nichts.
 */
export async function standZeilen(gemerkt: Map<string, { status: string; titel: string }>, lies: (id: string) => Promise<CmdbChangeRequest | null>): Promise<string | undefined> {
  const zeilen: string[] = [];
  for (const [id, vorher] of gemerkt) {
    let jetzt: CmdbChangeRequest | null;
    try { jetzt = await lies(id); } catch { jetzt = null; }
    const kurz = id.slice(0, 8);
    if (!jetzt) { zeilen.push(`- ${kurz} „${vorher.titel}“: Stand nicht lesbar — die Angaben oben sind nicht gegen die Datenbank geprüft.`); continue; }
    if (jetzt.status === vorher.status) continue;
    const wann = jetzt.status === 'in_progress' ? zeit(jetzt.startedAt) : zeit(jetzt.completedAt);
    zeilen.push(`- ${kurz} „${jetzt.title}“: jetzt ${STATUS_TEXT[jetzt.status] ?? jetzt.status}${wann} (vorher ${STATUS_TEXT[vorher.status] ?? vorher.status}).`);
  }
  return zeilen.length ? `**Stand laut Datenbank am Ende dieser Antwort** (hat sich während der Runde geändert):\n${zeilen.join('\n')}` : undefined;
}
