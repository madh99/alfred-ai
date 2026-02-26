#!/usr/bin/env node

import { startCommand } from './commands/start.js';
import { configCommand } from './commands/config.js';
import { rulesCommand } from './commands/rules.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';

const VERSION = '0.1.0';

const HELP_TEXT = `
Alfred CLI v${VERSION}
Personal AI Assistant

Usage:
  alfred <command> [options]

Commands:
  start          Start Alfred (load config, bootstrap, and run)
  config         Show current resolved configuration (API keys redacted)
  rules          List loaded security rules from the rules path
  status         Show status overview (adapters, LLM, rules)
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

  // Dispatch to command
  switch (parsed.command) {
    case 'start':
      await startCommand();
      break;

    case 'config':
      await configCommand();
      break;

    case 'rules':
      await rulesCommand();
      break;

    case 'status':
      await statusCommand();
      break;

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
