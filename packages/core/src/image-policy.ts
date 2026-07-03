import type { LLMProvider } from '@alfred/llm';

/**
 * v950 — Bildnisrecht-Schutz für generierte Social-Bilder.
 *
 * Anlass (Realfall 03.07.): gpt-image-1 erzeugte fotorealistische Lookalikes
 * echter Personen (Arnautovic/Alaba/Glasner in ÖFB-Optik) für einen
 * öffentlichen Kanal — rechtlich heikel (Persönlichkeits-/Bildnisrecht) und
 * für Follower nicht als KI erkennbar.
 *
 * Drei Schichten (Prompt-Appelle allein sind KEIN Fix):
 *   1. Policy je Kanal: image_policy 'symbolic' (DEFAULT, sicher) | 'people_ok'
 *      (explizites Opt-in des Users).
 *   2. Deterministisches Input-Gate: Personen-Namen werden aus dem Bild-Motiv
 *      GESCHRUBBT bevor es zum Generator geht; bleibt danach kein brauchbares
 *      Motiv, greift ein generisches Symbolmotiv.
 *   3. Vision-Output-Gate: das ERZEUGTE Bild wird per Vision-LLM geprüft
 *      („identifizierbare Person / Logo?"). Verstoß → ein Retry mit strengem
 *      Symbolmotiv ohne Menschen; erneuter Verstoß oder Vision-Ausfall →
 *      KEIN Bild (fail-closed bei 'symbolic' — Sicherheit vor Schönheit).
 */

export type ImagePolicy = 'symbolic' | 'people_ok';

export function resolveImagePolicy(config: Record<string, unknown>): ImagePolicy {
  return config.image_policy === 'people_ok' ? 'people_ok' : 'symbolic';
}

/** Deutsche Funktionswörter/Satzanfänge, die keine Namensbestandteile sind. */
const NAME_STOPWORDS = new Set([
  'das', 'der', 'die', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines',
  'und', 'oder', 'aber', 'doch', 'denn', 'wenn', 'als', 'wie', 'wo', 'was', 'wer', 'warum',
  'nur', 'nach', 'vor', 'mit', 'für', 'auf', 'aus', 'bei', 'über', 'unter', 'gegen', 'ohne',
  'durch', 'seit', 'zum', 'zur', 'beim', 'im', 'am', 'um', 'ins', 'vom', 'während', 'wegen',
  'trotz', 'statt', 'er', 'sie', 'es', 'wir', 'ihr', 'ich', 'du', 'sein', 'seine', 'ihre',
  'ihren', 'ihrem', 'unser', 'euer', 'kein', 'keine', 'alle', 'viele', 'mehr', 'heute',
  'morgen', 'gestern', 'jetzt', 'hier', 'dort', 'so', 'also', 'diese', 'dieser', 'dieses',
  'neue', 'neuer', 'neues', 'erste', 'zweite', 'letzte', 'dann', 'noch', 'schon', 'auch',
]);

/**
 * Schicht 2a — Namens-Kandidaten: Sequenzen von ≥2 kapitalisierten Wörtern
 * („Marko Arnautovic"), mit Stopwort-Beschneidung an den Rändern („Während
 * David Alaba" → „David Alaba"; „Das Stadion" → verworfen). Konservativ:
 * einzelne kapitalisierte Wörter sind im Deutschen Substantive und werden
 * NICHT geblockt — Einzel-Nachnamen fängt das Vision-Gate (Schicht 3).
 */
export function extractNameCandidates(...texts: Array<string | undefined>): string[] {
  const out = new Set<string>();
  const re = /\b([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+)\b/g;
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(re)) {
      let words = match[1].split(/\s+/);
      while (words.length > 0 && NAME_STOPWORDS.has(words[0].toLowerCase())) words = words.slice(1);
      while (words.length > 0 && NAME_STOPWORDS.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1);
      if (words.length >= 2) out.add(words.join(' '));
    }
  }
  return [...out];
}

const SYMBOLIC_FALLBACK_MOTIF =
  'Symbolbild Fußball: Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch, ohne Menschen';

/**
 * Schicht 2b — Motiv schrubben: alle Namens-Kandidaten entfernen. Bleibt kein
 * tragfähiges Motiv übrig, greift das generische Symbolmotiv.
 */
export function scrubMotif(motif: string, nameCandidates: string[]): { motif: string; scrubbed: boolean } {
  let result = motif;
  let scrubbed = false;
  for (const name of nameCandidates) {
    if (result.includes(name)) {
      result = result.split(name).join('');
      scrubbed = true;
    }
  }
  result = result.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  const meaningful = result.replace(/[^a-zA-ZäöüÄÖÜß]/g, '');
  if (meaningful.length < 15) {
    return { motif: SYMBOLIC_FALLBACK_MOTIF, scrubbed: true };
  }
  return { motif: result, scrubbed };
}

/** Schicht 1 — Prompt mit harten Policy-Regeln bauen. */
export function buildSafeImagePrompt(motif: string, persona: string | undefined, policy: ImagePolicy): string {
  const base = `${motif}. Stil: ${persona ?? 'modern, freundlich'}. Kein Text im Bild.`;
  if (policy === 'people_ok') return base;
  return `${base}
WICHTIGE REGELN (Bildnisrecht, zwingend):
- KEINE realen oder identifizierbaren Personen, KEINE Lookalikes von Personen des öffentlichen Lebens (Sportler, Trainer, Prominente).
- Wenn Menschen nötig wirken: nur anonym (von hinten, Silhouette, unkenntlich, Menge aus der Ferne) — besser ganz ohne Menschen.
- KEINE Vereins-, Verbands- oder Marken-Logos, keine erkennbaren Trikot-Embleme.
- Bevorzugt Symbolik: Stadion, Ball, Rasen, Taktiktafel, Fahnen ohne Embleme, abstrakte Grafik.`;
}

/** Strenges Retry-Motiv nach einem Vision-Verstoß. */
export function strictRetryPrompt(persona: string | undefined): string {
  return buildSafeImagePrompt(
    `${SYMBOLIC_FALLBACK_MOTIF}. Absolut keine Menschen, keine Gesichter, keine Logos`,
    persona, 'symbolic',
  );
}

export interface VisionVerdict {
  person: boolean;
  logo: boolean;
  begruendung?: string;
}

/**
 * Schicht 3 — Vision-Nachkontrolle des ERZEUGTEN Bildes.
 * @returns Verdict oder null bei Vision-Ausfall (Aufrufer entscheidet fail-closed).
 */
export async function verifyImagePolicy(
  llm: Pick<LLMProvider, 'complete'>,
  imageData: Buffer,
  mimeType = 'image/png',
): Promise<VisionVerdict | null> {
  try {
    const response = await llm.complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageData.toString('base64') } },
          {
            type: 'text',
            text: 'Prüfe dieses KI-generierte Bild für einen öffentlichen Social-Media-Kanal:\n'
              + '1. person: Zeigt es eine identifizierbare (auch nur ähnlich aussehende) reale Person, insbesondere Personen des öffentlichen Lebens (Sportler, Trainer, Promis)? Anonyme Silhouetten/Rückenansichten/unkenntliche Menschenmengen zählen NICHT.\n'
              + '2. logo: Zeigt es erkennbare Vereins-, Verbands- oder Markenlogos?\n'
              + 'Antworte NUR mit JSON: {"person": true|false, "logo": true|false, "begruendung": "1 Satz"}',
          },
        ],
      }],
      maxTokens: 200,
      tier: 'fast',
    });
    const match = response.content?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.person !== 'boolean') return null;
    return {
      person: parsed.person,
      logo: parsed.logo === true,
      begruendung: typeof parsed.begruendung === 'string' ? parsed.begruendung.slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}
