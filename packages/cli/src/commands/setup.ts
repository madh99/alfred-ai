import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ── ANSI helpers ──────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';

function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

function maskKey(key: string): string {
  if (key.length <= 4) return '****';
  return '*'.repeat(key.length - 4) + key.slice(-4);
}

// ── Provider definitions ──────────────────────────────────────────────
interface ProviderDef {
  name: string;
  label: string;
  defaultModel: string;
  envKeyName: string;
  needsApiKey: boolean;
  baseUrl?: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    name: 'anthropic',
    label: 'Anthropic (Claude) — recommended',
    defaultModel: 'claude-sonnet-4-20250514',
    envKeyName: 'ALFRED_ANTHROPIC_API_KEY',
    needsApiKey: true,
  },
  {
    name: 'openai',
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-4o',
    envKeyName: 'ALFRED_OPENAI_API_KEY',
    needsApiKey: true,
  },
  {
    name: 'openrouter',
    label: 'OpenRouter (multiple providers)',
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    envKeyName: 'ALFRED_OPENROUTER_API_KEY',
    needsApiKey: true,
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    name: 'ollama',
    label: 'Ollama (local, no API key needed)',
    defaultModel: 'llama3.2',
    envKeyName: '',
    needsApiKey: false,
    baseUrl: 'http://localhost:11434/v1',
  },
];

// ── Platform definitions ──────────────────────────────────────────────
interface PlatformDef {
  name: string;
  label: string;
  configKey: string;
  credentials: PlatformCredential[];
}

interface PlatformCredential {
  envKey: string;
  configField: string;
  prompt: string;
  defaultValue?: string;
  required: boolean;
}

const PLATFORMS: PlatformDef[] = [
  {
    name: 'telegram',
    label: 'Telegram',
    configKey: 'telegram',
    credentials: [
      {
        envKey: 'ALFRED_TELEGRAM_TOKEN',
        configField: 'token',
        prompt: 'Enter your Telegram Bot token (from @BotFather)',
        required: true,
      },
    ],
  },
  {
    name: 'discord',
    label: 'Discord',
    configKey: 'discord',
    credentials: [
      {
        envKey: 'ALFRED_DISCORD_TOKEN',
        configField: 'token',
        prompt: 'Enter your Discord Bot token',
        required: true,
      },
    ],
  },
  {
    name: 'whatsapp',
    label: 'WhatsApp',
    configKey: 'whatsapp',
    credentials: [],
  },
  {
    name: 'matrix',
    label: 'Matrix',
    configKey: 'matrix',
    credentials: [
      {
        envKey: 'ALFRED_MATRIX_HOMESERVER_URL',
        configField: 'homeserverUrl',
        prompt: 'Enter your Matrix homeserver URL',
        defaultValue: 'https://matrix.org',
        required: true,
      },
      {
        envKey: 'ALFRED_MATRIX_ACCESS_TOKEN',
        configField: 'accessToken',
        prompt: 'Enter your Matrix access token',
        required: true,
      },
      {
        envKey: 'ALFRED_MATRIX_USER_ID',
        configField: 'userId',
        prompt: 'Enter your Matrix user ID (e.g. @bot:matrix.org)',
        required: true,
      },
    ],
  },
  {
    name: 'signal',
    label: 'Signal',
    configKey: 'signal',
    credentials: [
      {
        envKey: 'ALFRED_SIGNAL_API_URL',
        configField: 'apiUrl',
        prompt: 'Enter the Signal REST API URL',
        defaultValue: 'http://localhost:8080',
        required: true,
      },
      {
        envKey: 'ALFRED_SIGNAL_PHONE_NUMBER',
        configField: 'phoneNumber',
        prompt: 'Enter the Signal phone number (e.g. +15551234567)',
        required: true,
      },
    ],
  },
];

// ── Main setup command ────────────────────────────────────────────────

export async function setupCommand(): Promise<void> {
  const rl = createInterface({ input, output });

  // Resolve project root (two levels up from packages/cli/src or dist)
  const projectRoot = process.cwd();

  try {
    printBanner();

    console.log(
      `${CYAN}Welcome to the Alfred setup wizard!${RESET}\n` +
      `${DIM}This will walk you through configuring your AI assistant.${RESET}\n` +
      `${DIM}Press Enter to accept defaults shown in [brackets].${RESET}\n`,
    );

    // ── 1. Bot name ───────────────────────────────────────────────
    const botName = await askWithDefault(rl, 'What should your bot be called?', 'Alfred');

    // ── 2. LLM Provider ──────────────────────────────────────────
    console.log(`\n${bold('Which LLM provider would you like to use?')}`);
    for (let i = 0; i < PROVIDERS.length; i++) {
      console.log(`  ${cyan(String(i + 1) + ')')} ${PROVIDERS[i].label}`);
    }
    const providerChoice = await askNumber(rl, '> ', 1, PROVIDERS.length, 1);
    const provider = PROVIDERS[providerChoice - 1];
    console.log(`  ${green('>')} Selected: ${bold(provider.label)}`);

    // ── 3. API key ───────────────────────────────────────────────
    let apiKey = '';
    if (provider.needsApiKey) {
      console.log('');
      apiKey = await askRequired(
        rl,
        `Enter your ${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)} API key`,
      );
      console.log(`  ${green('>')} API key set: ${dim(maskKey(apiKey))}`);
    } else {
      console.log(`  ${dim('No API key needed for Ollama.')}`);
    }

    // ── 4. Model ─────────────────────────────────────────────────
    console.log('');
    const model = await askWithDefault(rl, 'Which model?', provider.defaultModel);

    // ── 5. Platforms ─────────────────────────────────────────────
    console.log(`\n${bold('Which messaging platforms do you want to enable?')}`);
    console.log(`${dim('(Enter comma-separated numbers, e.g. 1,3)')}`);
    for (let i = 0; i < PLATFORMS.length; i++) {
      console.log(`  ${cyan(String(i + 1) + ')')} ${PLATFORMS[i].label}`);
    }
    console.log(`  ${cyan('0)')} None (configure later)`);

    const platformInput = (await rl.question(`${YELLOW}> ${RESET}`)).trim();

    const selectedPlatforms: PlatformDef[] = [];
    if (platformInput && platformInput !== '0') {
      const nums = platformInput.split(',').map((s) => parseInt(s.trim(), 10));
      for (const n of nums) {
        if (n >= 1 && n <= PLATFORMS.length) {
          const plat = PLATFORMS[n - 1];
          if (!selectedPlatforms.includes(plat)) {
            selectedPlatforms.push(plat);
          }
        }
      }
    }

    if (selectedPlatforms.length > 0) {
      console.log(
        `  ${green('>')} Enabling: ${selectedPlatforms.map((p) => bold(p.label)).join(', ')}`,
      );
    } else {
      console.log(`  ${dim('No platforms selected — you can configure them later.')}`);
    }

    // ── 6. Platform credentials ──────────────────────────────────
    const platformCredentials: Record<string, Record<string, string>> = {};
    const envOverrides: Record<string, string> = {};

    for (const platform of selectedPlatforms) {
      if (platform.credentials.length === 0) {
        if (platform.name === 'whatsapp') {
          console.log(
            `\n  ${yellow('i')} WhatsApp: a QR code will be displayed on first start.`,
          );
        }
        continue;
      }

      console.log(`\n${bold(platform.label + ' configuration:')}`);
      const creds: Record<string, string> = {};

      for (const cred of platform.credentials) {
        let value: string;
        if (cred.defaultValue) {
          value = await askWithDefault(rl, `  ${cred.prompt}`, cred.defaultValue);
        } else if (cred.required) {
          value = await askRequired(rl, `  ${cred.prompt}`);
        } else {
          value = (await rl.question(`  ${cred.prompt}: ${YELLOW}`)).trim();
          process.stdout.write(RESET);
        }

        creds[cred.configField] = value;
        envOverrides[cred.envKey] = value;

        // Mask tokens/keys in confirmation
        if (cred.configField === 'token' || cred.configField === 'accessToken') {
          console.log(`    ${green('>')} Set: ${dim(maskKey(value))}`);
        } else {
          console.log(`    ${green('>')} Set: ${dim(value)}`);
        }
      }

      platformCredentials[platform.configKey] = creds;
    }

    // ── 7. Owner user ID ─────────────────────────────────────────
    console.log('');
    const ownerUserIdInput = (
      await rl.question(
        `${BOLD}Owner user ID${RESET} ${dim('(optional, for elevated permissions)')}: ${YELLOW}`,
      )
    ).trim();
    process.stdout.write(RESET);

    const ownerUserId = ownerUserIdInput || '';

    // ── 8. Generate .env ─────────────────────────────────────────
    console.log(`\n${bold('Writing configuration files...')}`);

    const envLines: string[] = [
      '# Alfred Environment Variables',
      '# Generated by `alfred setup`',
      '',
      '# === LLM ===',
      '',
      `ALFRED_LLM_PROVIDER=${provider.name}`,
    ];

    if (apiKey) {
      envLines.push(`${provider.envKeyName}=${apiKey}`);
    }

    if (model !== provider.defaultModel) {
      envLines.push(`ALFRED_LLM_MODEL=${model}`);
    }

    if (provider.baseUrl) {
      envLines.push(`ALFRED_LLM_BASE_URL=${provider.baseUrl}`);
    }

    envLines.push('', '# === Messaging Platforms ===', '');

    for (const [envKey, envVal] of Object.entries(envOverrides)) {
      envLines.push(`${envKey}=${envVal}`);
    }

    envLines.push('', '# === Security ===', '');

    if (ownerUserId) {
      envLines.push(`ALFRED_OWNER_USER_ID=${ownerUserId}`);
    } else {
      envLines.push('# ALFRED_OWNER_USER_ID=');
    }

    envLines.push('');

    const envPath = path.join(projectRoot, '.env');
    fs.writeFileSync(envPath, envLines.join('\n'), 'utf-8');
    console.log(`  ${green('+')} ${dim('.env')} written`);

    // ── 9. Generate config/default.yml ───────────────────────────
    const configDir = path.join(projectRoot, 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    interface ConfigObj {
      name: string;
      telegram: { token: string; enabled: boolean };
      discord: { token: string; enabled: boolean };
      whatsapp: { enabled: boolean; dataPath: string };
      matrix: { homeserverUrl: string; accessToken: string; userId: string; enabled: boolean };
      signal: { apiUrl: string; phoneNumber: string; enabled: boolean };
      llm: { provider: string; model: string; temperature: number; maxTokens: number };
      storage: { path: string };
      logger: { level: string; pretty: boolean; auditLogPath: string };
      security: { rulesPath: string; defaultEffect: string; ownerUserId?: string };
    }

    const config: ConfigObj = {
      name: botName,
      telegram: {
        token: platformCredentials['telegram']?.['token'] ?? '',
        enabled: selectedPlatforms.some((p) => p.name === 'telegram'),
      },
      discord: {
        token: platformCredentials['discord']?.['token'] ?? '',
        enabled: selectedPlatforms.some((p) => p.name === 'discord'),
      },
      whatsapp: {
        enabled: selectedPlatforms.some((p) => p.name === 'whatsapp'),
        dataPath: './data/whatsapp',
      },
      matrix: {
        homeserverUrl: platformCredentials['matrix']?.['homeserverUrl'] ?? 'https://matrix.org',
        accessToken: platformCredentials['matrix']?.['accessToken'] ?? '',
        userId: platformCredentials['matrix']?.['userId'] ?? '',
        enabled: selectedPlatforms.some((p) => p.name === 'matrix'),
      },
      signal: {
        apiUrl: platformCredentials['signal']?.['apiUrl'] ?? 'http://localhost:8080',
        phoneNumber: platformCredentials['signal']?.['phoneNumber'] ?? '',
        enabled: selectedPlatforms.some((p) => p.name === 'signal'),
      },
      llm: {
        provider: provider.name,
        model,
        temperature: 0.7,
        maxTokens: 4096,
      },
      storage: {
        path: './data/alfred.db',
      },
      logger: {
        level: 'info',
        pretty: true,
        auditLogPath: './data/audit.log',
      },
      security: {
        rulesPath: './config/rules',
        defaultEffect: 'deny',
      },
    };

    if (ownerUserId) {
      config.security.ownerUserId = ownerUserId;
    }

    const yamlStr =
      '# Alfred — Configuration\n' +
      '# Generated by `alfred setup`\n' +
      '# Edit manually or re-run `alfred setup` to reconfigure.\n\n' +
      yaml.dump(config, { lineWidth: 120, noRefs: true, sortKeys: false });

    const configPath = path.join(configDir, 'default.yml');
    fs.writeFileSync(configPath, yamlStr, 'utf-8');
    console.log(`  ${green('+')} ${dim('config/default.yml')} written`);

    // ── 10. Ensure data/ directory exists ─────────────────────────
    const dataDir = path.join(projectRoot, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`  ${green('+')} ${dim('data/')} directory created`);
    }

    // ── 11. Summary ──────────────────────────────────────────────
    console.log('');
    console.log(`${GREEN}${'='.repeat(52)}${RESET}`);
    console.log(`${GREEN}${BOLD}  Setup complete!${RESET}`);
    console.log(`${GREEN}${'='.repeat(52)}${RESET}`);
    console.log('');
    console.log(`  ${bold('Bot name:')}       ${botName}`);
    console.log(`  ${bold('LLM provider:')}   ${provider.name} (${model})`);
    if (apiKey) {
      console.log(`  ${bold('API key:')}        ${maskKey(apiKey)}`);
    }
    if (selectedPlatforms.length > 0) {
      console.log(
        `  ${bold('Platforms:')}      ${selectedPlatforms.map((p) => p.label).join(', ')}`,
      );
    } else {
      console.log(`  ${bold('Platforms:')}      none (configure later)`);
    }
    if (ownerUserId) {
      console.log(`  ${bold('Owner ID:')}       ${ownerUserId}`);
    }
    console.log('');
    console.log(`${CYAN}Next steps:${RESET}`);
    console.log(`  ${bold('alfred start')}     Start Alfred`);
    console.log(`  ${bold('alfred status')}    Check configuration`);
    console.log(`  ${bold('alfred --help')}    Show all commands`);
    console.log('');
    console.log(
      `${DIM}Edit ${bold('.env')}${DIM} or ${bold('config/default.yml')}${DIM} for manual configuration.${RESET}`,
    );
    console.log('');
  } finally {
    rl.close();
  }
}

// ── Prompt helpers ────────────────────────────────────────────────────

async function askWithDefault(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue: string,
): Promise<string> {
  const answer = (
    await rl.question(`${BOLD}${prompt}${RESET} ${dim(`[${defaultValue}]`)}: ${YELLOW}`)
  ).trim();
  process.stdout.write(RESET);
  return answer || defaultValue;
}

async function askRequired(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  while (true) {
    const answer = (await rl.question(`${BOLD}${prompt}${RESET}: ${YELLOW}`)).trim();
    process.stdout.write(RESET);
    if (answer) return answer;
    console.log(`  ${red('!')} This field is required. Please enter a value.`);
  }
}

async function askNumber(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  min: number,
  max: number,
  defaultValue: number,
): Promise<number> {
  while (true) {
    const answer = (
      await rl.question(`${YELLOW}${prompt}${RESET}`)
    ).trim();
    if (!answer) return defaultValue;
    const n = parseInt(answer, 10);
    if (!Number.isNaN(n) && n >= min && n <= max) return n;
    console.log(`  ${red('!')} Please enter a number between ${min} and ${max}.`);
  }
}

// ── Banner ────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(`
${MAGENTA}${BOLD}     _    _     _____ ____  _____ ____
    / \\  | |   |  ___|  _ \\| ____|  _ \\
   / _ \\ | |   | |_  | |_) |  _| | | | |
  / ___ \\| |___|  _| |  _ <| |___| |_| |
 /_/   \\_\\_____|_|   |_| \\_\\_____|____/ ${RESET}
${DIM}  Personal AI Assistant — Setup Wizard${RESET}
`);
}
