#!/usr/bin/env node

// Commands are loaded dynamically via import() to avoid pulling in heavy
// dependencies (core → messaging → native modules) at startup. This keeps
// lightweight commands like --help, setup, config, status instant.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function getVersion(): string {
  try {
    // Try to read package.json (works in dev and bundled installs)
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../package.json', '../../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, rel), 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* fallback */ }
  return '0.0.0';
}

const VERSION = getVersion();

const HELP_TEXT = `
Alfred CLI v${VERSION}
Personal AI Assistant

Usage:
  alfred <command> [options]

Commands:
  start          Start Alfred (load config, bootstrap, and run)
  chat           Interactive terminal chat (--model, --tier)
  setup          Interactive setup wizard (configure LLM, platforms, API keys)
  config         Show current resolved configuration (API keys redacted)
  rules          List loaded security rules from the rules path
  status         Show status overview (adapters, LLM, rules)
  auth <provider>  OAuth token setup (e.g., alfred auth microsoft)
  logs [--tail N] Show recent audit log entries (default: 20)

Options:
  --help, -h     Show this help message
  --version, -v  Show version number
`.trim();

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // Skip node and script path
  const args = argv.slice(2);

  const command = args.length > 0 && !args[0].startsWith('-') ? args[0] : '';
  const remaining = command ? args.slice(1) : args;

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Check if next arg is a value (not another flag)
      if (i + 1 < remaining.length && !remaining[i + 1].startsWith('-')) {
        flags[key] = remaining[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < remaining.length && !remaining[i + 1].startsWith('-')) {
        flags[key] = remaining[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, flags, positional };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  // Handle global flags
  if (parsed.flags['help'] || parsed.flags['h']) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (parsed.flags['version'] || parsed.flags['v']) {
    console.log(`alfred v${VERSION}`);
    process.exit(0);
  }

  // Dispatch to command — dynamic imports keep startup fast
  switch (parsed.command) {
    case 'start': {
      const { startCommand } = await import('./commands/start.js');
      await startCommand();
      break;
    }

    case 'chat': {
      const { chatCommand } = await import('./commands/chat.js');
      await chatCommand({
        model: typeof parsed.flags['model'] === 'string' ? parsed.flags['model'] : undefined,
        tier: typeof parsed.flags['tier'] === 'string' ? parsed.flags['tier'] : undefined,
      });
      break;
    }

    case 'setup': {
      const { setupCommand } = await import('./commands/setup.js');
      await setupCommand();
      break;
    }

    case 'config': {
      const { configCommand } = await import('./commands/config.js');
      await configCommand();
      break;
    }

    case 'rules': {
      const { rulesCommand } = await import('./commands/rules.js');
      await rulesCommand();
      break;
    }

    case 'status': {
      const { statusCommand } = await import('./commands/status.js');
      await statusCommand();
      break;
    }

    case 'auth': {
      const provider = parsed.positional[0] ?? '';
      const { authCommand } = await import('./commands/auth.js');
      await authCommand(provider);
      break;
    }

    case 'logs': {
      const tailValue = parsed.flags['tail'];
      let tail = 20;
      if (typeof tailValue === 'string') {
        const tailNum = parseInt(tailValue, 10);
        if (Number.isNaN(tailNum) || tailNum <= 0) {
          console.error('Error: --tail must be a positive integer');
          process.exit(1);
        }
        tail = tailNum;
      }
      const { logsCommand } = await import('./commands/logs.js');
      await logsCommand(tail);
      break;
    }

    case 'help':
      console.log(HELP_TEXT);
      break;

    case '':
      console.log(HELP_TEXT);
      process.exit(0);
      break;

    default:
      console.error(`Unknown command: ${parsed.command}`);
      console.error('');
      console.error('Run "alfred --help" for usage information.');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
