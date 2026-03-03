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

    // Code blocks (``` ... ```) → <pre>...</pre>
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
      return `<pre>${this.escapeHTML(code.trimEnd())}</pre>`;
    });

    // Inline code (`...`) → <code>...</code>
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
      return `<code>${this.escapeHTML(code)}</code>`;
    });

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

    return html;
  }

  private toMatrixHTML(md: string): string {
    // Matrix uses the same HTML subset as Telegram
    return this.toTelegramHTML(md);
  }

  private toWhatsApp(md: string): string {
    let text = md;

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

    // Remove code blocks markers
    text = text.replace(/```\w*\n?/g, '');

    // Remove inline code markers
    text = text.replace(/`([^`]+)`/g, '$1');

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
