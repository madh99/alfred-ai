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
        return { text: this.toMarkdown(text), parseMode: 'markdown' };
      case 'matrix':
        return { text: this.toTelegramHTML(text), parseMode: 'html' };
      case 'whatsapp':
        return { text: this.toWhatsApp(text), parseMode: 'text' };
      case 'signal':
        return { text: this.stripFormatting(text), parseMode: 'text' };
      default:
        return { text, parseMode: 'text' };
    }
  }

  /**
   * Convert mixed Markdown+HTML input to clean Telegram-compatible HTML.
   *
   * Strategy: Convert Markdown constructs to HTML first, then clean up
   * any nesting/duplication issues in the final HTML. This avoids the
   * fragile HTML→MD→HTML roundtrip that breaks on nested tags.
   */
  private toTelegramHTML(input: string): string {
    let html = input;

    // 1. Protect code blocks from any processing
    const codeBlocks: string[] = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
      codeBlocks.push(`<pre>${this.escapeHTML(code.trimEnd())}</pre>`);
      return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    // 2. Protect inline code
    const inlineCodes: string[] = [];
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
      inlineCodes.push(`<code>${this.escapeHTML(code)}</code>`);
      return `\x00IC${inlineCodes.length - 1}\x00`;
    });

    // 3. Convert Markdown constructs to HTML
    // Headers → bold
    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // Horizontal rules → empty line
    html = html.replace(/^[-*_]{3,}\s*$/gm, '');

    // Bold Markdown → HTML (but don't touch already-HTML bold)
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    // Italic Markdown → HTML
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 4. Normalize HTML tags: <strong> → <b>, <em> → <i>, <del>/<strike> → <s>
    html = html.replace(/<(\/?)(?:strong)>/gi, '<$1b>');
    html = html.replace(/<(\/?)(?:em)>/gi, '<$1i>');
    html = html.replace(/<(\/?)(?:del|strike)>/gi, '<$1s>');

    // 5. Fix nested same-type tags: <b>...<b>inner</b>...</b> → <b>...inner...</b>
    for (const tag of ['b', 'i', 's', 'u']) {
      // Remove opening tags that are already inside the same tag type
      // Repeatedly apply until stable (handles multiple nesting levels)
      let prev = '';
      while (prev !== html) {
        prev = html;
        // Track tag depth and remove redundant opens/closes
        html = this.flattenNestedTag(html, tag);
      }
    }

    // 6. Strip HTML tags not supported by Telegram
    // Keep: b, i, s, u, a (with href), pre, code, tg-spoiler, tg-emoji, blockquote
    html = html.replace(/<(?!\/?(?:b|i|s|u|a|pre|code|tg-spoiler|tg-emoji|blockquote)(?:[\s>\/]|$))[^>]*>/gi, '');

    // 7. Escape stray < that aren't part of valid tags
    html = html.replace(/<(?!\/?(?:b|i|s|u|a|pre|code|tg-spoiler|tg-emoji|blockquote)(?:[\s>\/]|$))/gi, '&lt;');

    // 8. Restore code blocks and inline code
    html = html.replace(/\x00CB(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)]);
    html = html.replace(/\x00IC(\d+)\x00/g, (_match, idx) => inlineCodes[parseInt(idx)]);

    // 9. Collapse excessive blank lines (3+ → 2)
    html = html.replace(/\n{3,}/g, '\n\n');

    return html;
  }

  /**
   * Remove redundant nested tags of the same type.
   * e.g. <b>text <b>inner</b> more</b> → <b>text inner more</b>
   */
  private flattenNestedTag(html: string, tag: string): string {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    let depth = 0;
    let result = '';
    let i = 0;

    while (i < html.length) {
      // Check for opening tag
      if (html.slice(i, i + openTag.length).toLowerCase() === openTag) {
        depth++;
        if (depth === 1) {
          result += openTag;
        }
        // Skip redundant nested opens
        i += openTag.length;
        continue;
      }

      // Check for closing tag
      if (html.slice(i, i + closeTag.length).toLowerCase() === closeTag) {
        depth--;
        if (depth <= 0) {
          result += closeTag;
          depth = 0; // safety: don't go negative
        }
        // Skip redundant nested closes
        i += closeTag.length;
        continue;
      }

      result += html[i];
      i++;
    }

    return result;
  }

  /**
   * Convert mixed input to clean Markdown (for Discord).
   * Strips HTML tags back to Markdown equivalents.
   */
  private toMarkdown(input: string): string {
    let text = input;

    // Convert HTML to Markdown
    text = text.replace(/<\/?(?:b|strong)>/gi, '**');
    text = text.replace(/<\/?(?:i|em)>/gi, '*');
    text = text.replace(/<\/?(?:s|del|strike)>/gi, '~~');
    text = text.replace(/<code>([^<]*)<\/code>/gi, '`$1`');
    text = text.replace(/<pre>([^<]*)<\/pre>/gi, '```\n$1\n```');
    text = text.replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)');
    text = text.replace(/<[^>]+>/g, ''); // strip remaining HTML

    return text;
  }

  private toWhatsApp(input: string): string {
    let text = input;

    // Convert HTML tags to Markdown first
    text = text.replace(/<\/?(?:b|strong)>/gi, '**');
    text = text.replace(/<\/?(?:i|em)>/gi, '*');
    text = text.replace(/<\/?(?:s|del|strike)>/gi, '~~');
    text = text.replace(/<[^>]+>/g, ''); // strip remaining HTML

    // Headers → bold text
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Horizontal rules → empty line
    text = text.replace(/^[-*_]{3,}\s*$/gm, '');

    // Bold (**...**) → *...*
    text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Italic *...* → _..._
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

    // Strikethrough (~~...~~) → ~...~
    text = text.replace(/~~(.+?)~~/g, '~$1~');

    // Links [text](url) → text (url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    return text;
  }

  private stripFormatting(input: string): string {
    let text = input;

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
