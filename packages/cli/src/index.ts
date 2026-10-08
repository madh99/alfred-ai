#!/usr/bin/env node

// Commands are loaded dynamically via import() to avoid pulling in heavy
// dependencies (core → messaging → native modules) at startup. This keeps
// lightweight commands like --help, setup, config, status instant.

import { getVersion } from './version.js';

const VERSION = getVersion();

const HELP_TEXT = `
Alfred CLI v${VERSION}
Personal AI Assistant

Usage:
  alfred <command> [options]

Commands:
  start          Start Alfred (load config, bootstrap, and run)
  chat           Auf gekoppelten Geräten: die Sitzung (wie alfred sitzung); sonst Terminal-Chat zum Server (--model, --tier)
  pair           Dieses Gerät mit Alfred koppeln (--server <url> --code <Code> [--name] [--insecure] [--verzeichnisse "a;b"])
  einstellungen  Satelliten-Einstellungen anzeigen oder ändern (freigabe, fenster-sperre, foto-sperre, wort, sinne-fenster, oberflaeche)
  sitzung        EIN Terminal für alles: Chat als Owner, Sprache (/talk, /hören, /stimme), Bestätigungen (/ja, /nein), Satellit (--ohne-satellit, --einfach = ohne Ink-Oberfläche)
  satellit       Gerätedienst: Verbindung zum Gehirn halten, Aktionen lokal ausführen (--einmal, --install, --starter = alfred in den PATH)
                   --install    als Autostart-Dienst einrichten (Aufgabenplanung / launchd / systemd --user)
                   --uninstall  Autostart-Dienst entfernen     --status  Zustand des Dienstes
                   --entkoppeln Gerät vollständig entfernen (Token im Gehirn, Kopplung, Versionen, Dienst)
  setup          Interactive setup wizard (configure LLM, platforms, API keys)
  config         Show current resolved configuration (API keys redacted)
  rules          List loaded security rules from the rules path
  status         Show status overview (adapters, LLM, rules)
  auth <provider>  OAuth token setup (e.g., alfred auth microsoft)
  migrate-db     Migrate SQLite data to PostgreSQL
                   --connection-string <url>  PostgreSQL URL (overrides config)
                   --batch-size <n>           Rows per INSERT batch (default: 500)
                   --dry-run                  Show what would be migrated
                   --skip-existing            Skip tables that already have PG data
  logs [--tail N] Show recent audit log entries (default: 20)
                   --activity          Show activity log instead of security audit log
                   --type <type>       Filter by event type (skill_exec, watch_trigger, etc.)
                   --source <source>   Filter by source (user, watch, scheduled, background, system)
                   --outcome <outcome> Filter by outcome (success, error, denied, approved, etc.)
                   --since <date>      Show entries since date (ISO format)
                   --stats             Show summary statistics

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

  // v1258 — Starter: für satellit/sitzung die neueste vom Server installierte Version ausführen und auf sie warten
  // v1266 — auch für `start`: das Selbstupdate installiert nach ~/.alfred/cli/<Version> und beendet sich mit 75
  // v1282 — ALLE Befehle laufen in der neuesten installierten Version (Realfall: `alfred auth` lief auf dem Server noch mit dem alten globalen Starter)
  if (parsed.command && !process.env.ALFRED_STARTER_VERSION && !process.env.ALFRED_KEIN_UPDATE) {
    const { starteNeuesteVersion } = await import('./commands/satellit-update.js');
    // Dienstmodus: immer als Kind, damit nach einem Update (Code 75) der Starter die neue Version startet
    // v1299 — auch der Vordergrund-Satellit (`alfred satellit` ohne --dienst) läuft immer als Kind: lief er in diesem Prozess,
    // beendete ihn das eigene Update mit Code 75 und niemand startete ihn neu (Realfall Office-VM 08.10., 35 min offline)
    const satellitLauf = parsed.command === 'satellit' && !parsed.flags['install'] && !parsed.flags['uninstall'] && !parsed.flags['status'] && !parsed.flags['entkoppeln'] && !parsed.flags['einmal'] && !parsed.flags['starter'];
    const code = starteNeuesteVersion(VERSION, process.argv.slice(2), satellitLauf);
    if (code !== undefined) process.exit(code);
  }

  // Dispatch to command — dynamic imports keep startup fast
  switch (parsed.command) {
    case 'start': {
      const { startCommand } = await import('./commands/start.js');
      await startCommand();
      break;
    }

    case 'einstellungen': { // v1309 — Satelliten-Einstellungen ohne Sitzung: anzeigen oder einen Befehl anwenden
      const { einstellungenCommand } = await import('./commands/sitzung-einstellungen.js');
      await einstellungenCommand(process.argv.slice(process.argv.indexOf('einstellungen') + 1));
      break;
    }

    case 'chat': {
      // v1307 — gekoppeltes Gerät: alfred chat öffnet die Sitzung (Satellit, Bestätigungen, Sprache); sonst der alte Server-Chat
      const { ladeKonfig: ladeGeraet } = await import('./commands/pair.js');
      if (ladeGeraet()) { const { sitzungCommand } = await import('./commands/sitzung.js'); await sitzungCommand({ ohneSatellit: !!parsed.flags['ohne-satellit'], einfach: !!parsed.flags['einfach'] }); break; }
      const { chatCommand } = await import('./commands/chat.js');
      await chatCommand({
        model: typeof parsed.flags['model'] === 'string' ? parsed.flags['model'] : undefined,
        tier: typeof parsed.flags['tier'] === 'string' ? parsed.flags['tier'] : undefined,
      });
      break;
    }

    case 'pair': {
      const { pairCommand } = await import('./commands/pair.js');
      await pairCommand({
        server: typeof parsed.flags['server'] === 'string' ? parsed.flags['server'] : undefined,
        code: typeof parsed.flags['code'] === 'string' ? parsed.flags['code'] : (parsed.positional[0] ?? undefined),
        name: typeof parsed.flags['name'] === 'string' ? parsed.flags['name'] : undefined,
        insecure: !!parsed.flags['insecure'],
        verzeichnisse: typeof parsed.flags['verzeichnisse'] === 'string' ? parsed.flags['verzeichnisse'] : undefined,
      });
      break;
    }

    case 'sitzung': {
      if (parsed.flags['hoertest']) { // v1251 — eine WAV durch das Hör-Relais schicken
        const { hoerTest } = await import('./commands/satellit-hoeren.js');
        const { ladeKonfig } = await import('./commands/pair.js');
        const k = ladeKonfig(); if (!k) { console.error('Nicht gekoppelt (alfred pair).'); process.exit(1); }
        await hoerTest(k, String(parsed.flags['hoertest']));
        process.exit(0);
      }
      if (parsed.flags['mikrofontest']) { // v1250 — Mikrofonstrom + Satzende-Erkennung lokal prüfen
        const { mikrofonTest } = await import('./commands/satellit-audio.js');
        const { SatzendeErkenner, rms16 } = await import('@alfred/core');
        await mikrofonTest(Number(parsed.flags['mikrofontest']) || 10, new SatzendeErkenner(), rms16);
        process.exit(0);
      }
      const { sitzungCommand } = await import('./commands/sitzung.js');
      await sitzungCommand({ ohneSatellit: !!parsed.flags['ohne-satellit'], einfach: !!parsed.flags['einfach'] }); // v1303 --einfach = readline statt Ink
      break;
    }
    case 'satellit': {
      const { satellitCommand } = await import('./commands/satellit.js');
      await satellitCommand({ einmal: !!parsed.flags['einmal'], install: !!parsed.flags['install'], uninstall: !!parsed.flags['uninstall'], status: !!parsed.flags['status'], entkoppeln: !!parsed.flags['entkoppeln'], dienst: !!parsed.flags['dienst'], starter: !!parsed.flags['starter'] }); // v1304 --starter
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
      await authCommand(provider, { sync: !!parsed.flags['sync'] }); // v1315 --sync
      break;
    }

    case 'mcp-server': {
      // v850 — alfred als stdio MCP-Server starten. Wird von claude-code,
      // codex, vibe als child-process gestartet (via --mcp-config oder
      // mcp_servers config-block). Liest config aus env + DB-Adapter.
      const { mcpServerCommand } = await import('./commands/mcp-server.js');
      await mcpServerCommand();
      break;
    }

    case 'migrate-db': {
      const { migrateDbCommand } = await import('./commands/migrate-db.js');
      await migrateDbCommand({
        connectionString: typeof parsed.flags['connection-string'] === 'string' ? parsed.flags['connection-string'] : undefined,
        batchSize: typeof parsed.flags['batch-size'] === 'string' ? parseInt(parsed.flags['batch-size'], 10) : undefined,
        dryRun: !!parsed.flags['dry-run'],
        skipExisting: !!parsed.flags['skip-existing'],
      });
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
      await logsCommand(tail, {
        activity: !!parsed.flags['activity'],
        type: typeof parsed.flags['type'] === 'string' ? parsed.flags['type'] : undefined,
        source: typeof parsed.flags['source'] === 'string' ? parsed.flags['source'] : undefined,
        outcome: typeof parsed.flags['outcome'] === 'string' ? parsed.flags['outcome'] : undefined,
        since: typeof parsed.flags['since'] === 'string' ? parsed.flags['since'] : undefined,
        stats: !!parsed.flags['stats'],
      });
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
