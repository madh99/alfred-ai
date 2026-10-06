/**
 * v1202 — Jarvis Interaktion: Sprache.
 *
 * Spezifikation: „Sprache über vorhandene STT/TTS … Standard knapp." Whisper-Transkription
 * und Sprachsynthese existieren seit langem, aber eine Sprachnachricht wurde mit Text
 * beantwortet. Wer spricht, bekommt jetzt zusätzlich eine gesprochene Antwort — knapp,
 * ohne Markdown, an Satzgrenzen gekürzt. Die Textantwort bleibt (Links, Listen, Details).
 */
export const SPRACHFASSUNG_MAX_ZEICHEN = 700;

/**
 * v1247 — Streaming-Sprache, Stufe 1: Die Antwort wird in Blöcke aus ganzen Sätzen geteilt; der nächste Block
 * wird synthetisiert, während der vorige abgespielt wird. Erster Ton nach dem ersten Block statt nach dem ganzen Text.
 * Blöcke sind mindestens `min` Zeichen (sonst zu viele kleine Anfragen), höchstens `maxBloecke`.
 */
export function sprachBloecke(text: string, min = 90, maxBloecke = 6): string[] {
  const t = sprachfassung(text, 100_000);
  if (!t) return [];
  const saetze = t.split(/(?<=[.!?…])\s+(?=[^\s])/).map(s => s.trim()).filter(Boolean);
  const bloecke: string[] = [];
  let aktuell = '';
  for (const satz of saetze) {
    aktuell = aktuell ? `${aktuell} ${satz}` : satz;
    if (aktuell.length >= min && bloecke.length < maxBloecke - 1) { bloecke.push(aktuell); aktuell = ''; }
  }
  if (aktuell) bloecke.push(aktuell);
  return bloecke;
}

/** v1241 — MIME-Typ synthetisierter Sprache aus den ersten Bytes (Mistral liefert mp3, OpenAI opus/ogg). */
export function audioMimeAusBytes(data: Buffer): string {
  if (data.length >= 4 && data.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (data.length >= 3 && data.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (data.length >= 4 && data.toString('latin1', 0, 4) === 'RIFF') return 'audio/wav';
  return 'application/octet-stream';
}

/** Text für die Sprachausgabe: Markdown raus, Listen zu Sätzen, an Satzgrenze gekürzt. */
export function sprachfassung(text: string, max = SPRACHFASSUNG_MAX_ZEICHEN): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' Codeblock im Chat. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link im Chat')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\n)\s*[-*•]\s+/g, '$1')
    .replace(/(^|\n)\s*\d+[.)]\s+/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const kurz = t.slice(0, max);
  const satzende = Math.max(kurz.lastIndexOf('. '), kurz.lastIndexOf('! '), kurz.lastIndexOf('? '));
  const schnitt = satzende > max * 0.4 ? satzende + 1 : kurz.lastIndexOf(' ');
  return `${t.slice(0, schnitt).trim()} Mehr dazu im Chat.`;
}

/** Hat die eingehende Nachricht eine Sprach- oder Audio-Anlage? */
export function istSprachnachricht(attachments: Array<{ type: string }> | undefined): boolean {
  return (attachments ?? []).some(a => a.type === 'audio');
}
