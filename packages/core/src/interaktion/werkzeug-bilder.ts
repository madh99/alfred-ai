import type { LLMContentBlock, SkillResultAttachment } from '@alfred/types';

/**
 * v1268 — Bilder aus Werkzeugergebnissen (Bildschirmfoto vom Gerät, Browser-Screenshot) sieht das Modell.
 * Die Pipeline hängt sie als Bildblöcke hinter die tool_result-Blöcke derselben Nutzer-Nachricht; alle Provider
 * kennen Bildblöcke in Nutzer-Nachrichten (Anthropic, OpenAI/Mistral als input_image, Google inlineData, Ollama).
 * Grenzen: höchstens `maxBilder` je Runde, je höchstens `maxBytes`, nie in die Gesprächshistorie (DB).
 */
export const WERKZEUG_BILD_MAX_BYTES = 2 * 1024 * 1024;
export const WERKZEUG_BILDER_MAX = 3;

export function bildBloeckeAusAnhaengen(anhaenge: SkillResultAttachment[] | undefined, maxBilder = WERKZEUG_BILDER_MAX, maxBytes = WERKZEUG_BILD_MAX_BYTES): LLMContentBlock[] {
  if (!anhaenge?.length) return [];
  const bilder = anhaenge.filter(a => /^image\/(jpeg|png|webp|gif)$/i.test(a.mimeType ?? '') && a.data && a.data.length > 0 && a.data.length <= maxBytes).slice(0, maxBilder);
  if (bilder.length === 0) return [];
  const out: LLMContentBlock[] = [{ type: 'text', text: `Bild${bilder.length > 1 ? 'er' : ''} aus den Werkzeugergebnissen (${bilder.map(b => b.fileName).join(', ')}) — du siehst ${bilder.length > 1 ? 'sie' : 'es'} hier:` }];
  for (const b of bilder) out.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType.toLowerCase(), data: b.data.toString('base64') } });
  return out;
}

/** Entfernt Bild- und Begleittextblöcke, bevor Werkzeugergebnisse in die Historie geschrieben werden. */
export function ohneBilder(bloecke: LLMContentBlock[]): LLMContentBlock[] {
  return bloecke.filter(b => b.type === 'tool_result' || b.type === 'tool_use');
}
