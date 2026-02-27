import readline from 'node:readline';
import type { Platform, NormalizedMessage, SendMessageOptions } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

/**
 * CLI messaging adapter — interactive terminal chat.
 * Emits normalized messages from stdin, prints responses to stdout.
 */
export class CLIAdapter extends MessagingAdapter {
  readonly platform: Platform = 'cli';
  private rl?: readline.Interface;
  private messageCounter = 0;

  async connect(): Promise<void> {
    this.status = 'connecting';

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'You: ',
    });

    console.log('\nAlfred Chat — type your message and press Enter. Use /quit or /exit to leave.\n');

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.prompt();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\nGoodbye!\n');
        this.emit('disconnected');
        return;
      }

      this.messageCounter++;
      const message: NormalizedMessage = {
        id: `cli-${this.messageCounter}`,
        platform: 'cli',
        chatId: 'cli-chat',
        chatType: 'dm',
        userId: 'cli-user',
        userName: 'cli-user',
        displayName: 'You',
        text: trimmed,
        timestamp: new Date(),
      };

      this.emit('message', message);
    });

    this.rl.on('close', () => {
      this.emit('disconnected');
    });

    this.status = 'connected';
    this.emit('connected');
    this.prompt();
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    this.status = 'disconnected';
  }

  async sendMessage(_chatId: string, text: string, _options?: SendMessageOptions): Promise<string> {
    const id = `cli-resp-${++this.messageCounter}`;
    // Clear current line and print response
    process.stdout.write(`\nAlfred: ${text}\n`);
    this.prompt();
    return id;
  }

  async editMessage(_chatId: string, _messageId: string, text: string, _options?: SendMessageOptions): Promise<void> {
    // Overwrite current line with updated status
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Alfred: ${text}`);
  }

  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {
    // No-op for CLI
  }

  private prompt(): void {
    this.rl?.prompt();
  }
}
