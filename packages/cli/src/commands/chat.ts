import http from 'node:http';
import readline from 'node:readline';
import { ConfigLoader } from '@alfred/config';
import { Alfred } from '@alfred/core';
import type { ModelTier } from '@alfred/types';

/**
 * Check if the Alfred HTTP API server is reachable.
 */
function checkHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/health`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { status?: string };
          resolve(parsed.status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Run in HTTP client mode — connect to a running Alfred server via SSE.
 */
function startClientMode(host: string, port: number): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  console.log('\nAlfred Chat (connected to server) — type your message and press Enter. Use /quit or /exit to leave.\n');
  rl.prompt();

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('\nGoodbye!\n');
      rl.close();
      process.exit(0);
    }

    // Send message to server
    const body = JSON.stringify({ text: trimmed, chatId: 'api-chat', userId: 'api-user' });
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/api/message',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Parse SSE events from buffer
          const parts = buffer.split('\n\n');
          // Keep the last potentially incomplete part
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            const dataLine = part.split('\n').find(l => l.startsWith('data: '));
            if (!dataLine) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as {
                type: string;
                text?: string;
                attachmentType?: string;
                fileName?: string;
              };

              switch (event.type) {
                case 'status':
                  // Overwrite current line with status
                  readline.clearLine(process.stdout, 0);
                  readline.cursorTo(process.stdout, 0);
                  process.stdout.write(`Alfred: ${event.text ?? ''}`);
                  break;
                case 'response':
                  // Print final response
                  readline.clearLine(process.stdout, 0);
                  readline.cursorTo(process.stdout, 0);
                  process.stdout.write(`\nAlfred: ${event.text ?? ''}\n`);
                  break;
                case 'attachment': {
                  const name = event.fileName ?? event.attachmentType ?? 'file';
                  process.stdout.write(`[Attachment: ${name}]\n`);
                  break;
                }
                case 'done':
                  rl.prompt();
                  break;
                case 'error':
                  process.stdout.write(`\nError: ${event.text ?? 'Unknown error'}\n`);
                  rl.prompt();
                  break;
              }
            } catch {
              // Ignore malformed events
            }
          }
        });

        res.on('end', () => {
          // If we haven't prompted yet (e.g. done event was in last chunk)
          if (buffer.length > 0) {
            const dataLine = buffer.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6)) as { type: string };
                if (event.type === 'done' || event.type === 'error') {
                  rl.prompt();
                }
              } catch {
                // ignore
              }
            }
          }
        });

        res.on('error', (err) => {
          console.error(`\nConnection error: ${err.message}`);
          rl.prompt();
        });
      },
    );

    req.on('error', (err) => {
      console.error(`\nFailed to send message: ${err.message}`);
      rl.prompt();
    });

    req.write(body);
    req.end();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

export async function chatCommand(flags: { model?: string; tier?: string }): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  // Check if Alfred server is already running
  const apiHost = config.api?.host ?? '127.0.0.1';
  const apiPort = config.api?.port ?? 3420;

  const serverRunning = await checkHealth(apiHost, apiPort);
  if (serverRunning) {
    console.log(`Connected to Alfred server at ${apiHost}:${apiPort}`);
    startClientMode(apiHost, apiPort);
    return;
  }

  // Fallback: standalone mode
  // Suppress noisy logs in interactive chat
  config.logger.level = 'warn';

  // --model override: set the default tier's model
  if (flags.model) {
    config.llm.default.model = flags.model;
  }

  // --tier override: promote that tier's config to default
  if (flags.tier) {
    const tierConfig = config.llm[flags.tier as ModelTier];
    if (tierConfig) {
      config.llm.default = tierConfig;
    } else {
      console.error(`Unknown tier: ${flags.tier}. Available tiers: default, strong, fast, embeddings, local`);
      process.exit(1);
    }
  }

  const alfred = new Alfred(config);

  try {
    await alfred.initialize();
    await alfred.startWithCLI();
  } catch (error) {
    console.error('Failed to start chat:', (error as Error).message);
    process.exit(1);
  }
}
