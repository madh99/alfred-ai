import type { Platform } from '@alfred/types';

export interface FormattedResponse {
  text: string;
  parseMode: 'text' | 'markdown' | 'html';
}

export class ResponseFormatter {
  format(text: string, platform: Platform): FormattedResponse {
    switch (platform) {
      case 'telegram':
        return { text: this.toTelegramHTML(text), parseMode: 'html' };
      case 'discord':
        return { text, parseMode: 'markdown' };
      case 'matrix':
        return { text: this.toMatrixHTML(text), parseMode: 'html' };
      case 'whatsapp':
        return { text: this.toWhatsApp(text), parseMode: 'text' };
      case 'signal':
        return { text: this.stripFormatting(text), parseMode: 'text' };
      default:
        return { text, parseMode: 'text' };
    }
  }

  private toTelegramHTML(md: string): string {
    let html = md;

    // Strip existing HTML tags that the LLM might have emitted (except in code blocks).
    // We'll re-create formatting from Markdown only, so mixed HTML+MD doesn't break.
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match) => `\x00CODEBLOCK${match}\x00`);
    html = html.replace(/<\/?(?:b|i|s|u|em|strong|strike|del)>/gi, (tag) => {
      // Map HTML formatting tags back to Markdown equivalents
      const t = tag.toLowerCase();
      if (/<b>|<strong>/i.test(t)) return '**';
      if (/<\/b>|<\/strong>/i.test(t)) return '**';
      if (/<i>|<em>/i.test(t)) return '*';
      if (/<\/i>|<\/em>/i.test(t)) return '*';
      if (/<s>|<del>|<strike>/i.test(t)) return '~~';
      if (/<\/s>|<\/del>|<\/strike>/i.test(t)) return '~~';
      return '';
    });
    html = html.replace(/\x00CODEBLOCK([\s\S]*?)\x00/g, '$1');

    // Code blocks (``` ... ```) → <pre>...</pre>
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
      return `<pre>${this.escapeHTML(code.trimEnd())}</pre>`;
    });

    // Inline code (`...`) → <code>...</code>
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
      return `<code>${this.escapeHTML(code)}</code>`;
    });

    // Headers (## ...) → <b>...</b> (Telegram has no header tags)
    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // Horizontal rules (--- or ***) → empty line
    html = html.replace(/^[-*_]{3,}\s*$/gm, '');

    // Bold (**...**) → <b>...</b>
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    // Italic (*...*) — careful not to match bold
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

    // Strikethrough (~~...~~) → <s>...</s>
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links [text](url) → <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Escape stray < in non-tag content (e.g. "<3s" or "x<y").
    // Keep only known Telegram HTML tags: b, i, s, u, a, pre, code, tg-spoiler, tg-emoji, blockquote
    html = html.replace(/<(?!\/?(?:b|i|s|u|a|pre|code|tg-spoiler|tg-emoji|blockquote)(?:[\s>\/]|$))/gi, '&lt;');

    // Collapse excessive blank lines (3+ → 2)
    html = html.replace(/\n{3,}/g, '\n\n');

    return html;
  }

  private toMatrixHTML(md: string): string {
    // Matrix uses the same HTML subset as Telegram
    return this.toTelegramHTML(md);
  }

  private toWhatsApp(md: string): string {
    let text = md;

    // Strip HTML tags the LLM might have emitted
    text = text.replace(/<\/?(?:b|i|s|u|em|strong|strike|del)>/gi, (tag) => {
      const t = tag.toLowerCase();
      if (/<b>|<strong>/i.test(t)) return '**';
      if (/<\/b>|<\/strong>/i.test(t)) return '**';
      if (/<i>|<em>/i.test(t)) return '*';
      if (/<\/i>|<\/em>/i.test(t)) return '*';
      if (/<s>|<del>|<strike>/i.test(t)) return '~~';
      if (/<\/s>|<\/del>|<\/strike>/i.test(t)) return '~~';
      return '';
    });
    text = text.replace(/<[^>]+>/g, ''); // strip remaining HTML tags

    // Headers → bold text
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Horizontal rules → empty line
    text = text.replace(/^[-*_]{3,}\s*$/gm, '');

    // Code blocks — WhatsApp uses triple backticks natively, keep as-is
    // Bold (**...**) → *...*
    text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Italic — single * already means italic in WhatsApp, but markdown uses *...*
    // After converting bold, remaining single * should be _ for WhatsApp italic
    // Actually, markdown italic *text* → WhatsApp _text_
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

    // Strikethrough (~~...~~) → ~...~
    text = text.replace(/~~(.+?)~~/g, '~$1~');

    // Links [text](url) → text (url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    return text;
  }

  private stripFormatting(md: string): string {
    let text = md;

    // Strip HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Remove code blocks markers
    text = text.replace(/```\w*\n?/g, '');

    // Remove inline code markers
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove headers markers
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Remove horizontal rules
    text = text.replace(/^[-*_]{3,}\s*$/gm, '');

    // Remove bold markers
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');

    // Remove italic markers
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');

    // Remove strikethrough markers
    text = text.replace(/~~(.+?)~~/g, '$1');

    // Simplify links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    return text;
  }

  private escapeHTML(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
