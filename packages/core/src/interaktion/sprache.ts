/**
 * v1202 — Jarvis Interaktion: Sprache.
 *
 * Spezifikation: „Sprache über vorhandene STT/TTS … Standard knapp." Whisper-Transkription
 * und Sprachsynthese existieren seit langem, aber eine Sprachnachricht wurde mit Text
 * beantwortet. Wer spricht, bekommt jetzt zusätzlich eine gesprochene Antwort — knapp,
 * ohne Markdown, an Satzgrenzen gekürzt. Die Textantwort bleibt (Links, Listen, Details).
 */
export const SPRACHFASSUNG_MAX_ZEICHEN = 700;

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
