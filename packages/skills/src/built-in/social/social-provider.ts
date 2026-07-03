import type { SocialChannel, ContentItem } from '@alfred/storage';

export interface ProviderCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  maxTextLength?: number;
  supportsDelete: boolean;
  supportsMetrics: boolean;
}

export interface PublishResult {
  externalId: string;
  url?: string;
}

/**
 * v933 — Kanal-Provider (Muster: marketplace/). Secrets kommen NIE aus der DB,
 * sondern werden vom Kern pro Aufruf aufgelöst (project_environments,
 * Stage aus channel.config.env_stage — verschlüsselt via envEncryptionKey).
 */
export abstract class SocialProvider {
  abstract readonly platform: string;
  abstract capabilities(): ProviderCapabilities;
  abstract publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult>;
  /** Prüft Credentials/Erreichbarkeit ohne zu posten. */
  abstract validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
  /** Optional: Post wieder löschen (Leitplanke 6). */
  async deletePost(_externalId: string, _channel: SocialChannel, _secrets: Record<string, string>): Promise<boolean> {
    return false;
  }
}

/** Baut den fertigen Post-Text (Body + Hashtags) mit optionalem Längen-Limit. */
export function composePostText(item: ContentItem, maxLength?: number): string {
  const tags = item.hashtags.length > 0 ? '\n\n' + item.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ') : '';
  let text = `${item.title ? `${item.title}\n\n` : ''}${item.body}${tags}`;
  if (maxLength && text.length > maxLength) {
    // Hashtags haben Vorrang vor den letzten Body-Zeichen
    const room = maxLength - tags.length - 2;
    text = `${(item.title ? `${item.title}\n\n` : '') + item.body}`.slice(0, Math.max(0, room)) + '…' + tags;
  }
  return text;
}
