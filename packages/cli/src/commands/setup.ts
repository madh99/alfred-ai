import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { getModels, mergeModels } from '../model-discovery.js';

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
  models?: { id: string; desc: string }[];
}

const PROVIDERS: ProviderDef[] = [
  {
    name: 'anthropic',
    label: 'Anthropic (Claude) — recommended',
    defaultModel: 'claude-sonnet-4-20250514',
    envKeyName: 'ALFRED_ANTHROPIC_API_KEY',
    needsApiKey: true,
    models: [
      { id: 'claude-sonnet-4-20250514', desc: 'Sonnet 4 — fast, smart, recommended' },
      { id: 'claude-opus-4-20250514',   desc: 'Opus 4 — most capable, slower' },
      { id: 'claude-haiku-4-5-20251001', desc: 'Haiku 4.5 — fastest, cheapest' },
    ],
  },
  {
    name: 'openai',
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-4o',
    envKeyName: 'ALFRED_OPENAI_API_KEY',
    needsApiKey: true,
    models: [
      { id: 'gpt-4o',       desc: 'GPT-4o — flagship, 128k context' },
      { id: 'gpt-4o-mini',  desc: 'GPT-4o Mini — fast, cheap, 128k context' },
      { id: 'o3-mini',      desc: 'o3-mini — reasoning, 200k context' },
    ],
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
    baseUrl: 'http://localhost:11434',
  },
  {
    name: 'openwebui',
    label: 'OpenWebUI (local OpenAI-compatible UI)',
    defaultModel: 'llama3.2',
    envKeyName: 'ALFRED_OPENWEBUI_API_KEY',
    needsApiKey: true,
    baseUrl: 'http://localhost:3000/api/v1',
  },
  {
    name: 'google',
    label: 'Google (Gemini)',
    defaultModel: 'gemini-2.0-flash',
    envKeyName: 'ALFRED_GOOGLE_API_KEY',
    needsApiKey: true,
    models: [
      { id: 'gemini-2.0-flash', desc: 'Flash 2.0 — fast, 1M context' },
      { id: 'gemini-2.0-pro',   desc: 'Pro 2.0 — capable, 1M context' },
      { id: 'gemini-1.5-pro',   desc: 'Pro 1.5 — 2M context' },
      { id: 'gemini-1.5-flash', desc: 'Flash 1.5 — fast, 1M context' },
    ],
  },
  {
    name: 'mistral',
    label: 'Mistral AI',
    defaultModel: 'mistral-small-latest',
    envKeyName: 'ALFRED_MISTRAL_API_KEY',
    needsApiKey: true,
    models: [
      { id: 'mistral-small-latest',    desc: 'Small 3.2 — fast, 128k context, best value' },
      { id: 'mistral-medium-latest',   desc: 'Medium 3.1 — balanced, 128k context' },
      { id: 'mistral-large-latest',    desc: 'Large 3 — flagship, 256k context' },
      { id: 'codestral-latest',        desc: 'Codestral — code-optimized, 256k context' },
      { id: 'magistral-medium-latest', desc: 'Magistral Medium — reasoning, 40k context' },
      { id: 'magistral-small-latest',  desc: 'Magistral Small — reasoning (light), 40k context' },
      { id: 'ministral-8b-latest',     desc: 'Ministral 8B — edge/tiny, 128k context' },
    ],
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

// ── Agent detection helpers ───────────────────────────────────────────

/**
 * Try to find a command: first via which/where, then by checking common
 * installation directories that may not be in PATH (e.g. ~/.local/bin).
 * Returns the resolved absolute path or null.
 */
function findCommand(cmd: string): string | null {
  const isWin = process.platform === 'win32';
  const whichCmd = isWin ? 'where' : 'which';

  // 1. Standard which / where
  try {
    const result = execFileSync(whichCmd, [cmd], { stdio: 'pipe' }).toString().trim();
    if (result) return result.split(/\r?\n/)[0]; // where may return multiple lines
  } catch { /* not in PATH */ }

  // 2. Probe well-known directories
  const home = os.homedir();
  const candidates: string[] = isWin
    ? [
        path.join(home, '.local', 'bin', `${cmd}.exe`),
        path.join(home, 'AppData', 'Roaming', 'npm', `${cmd}.cmd`),
        path.join(home, 'AppData', 'Roaming', 'npm', `${cmd}`),
      ]
    : [
        path.join(home, '.local', 'bin', cmd),
        '/usr/local/bin/' + cmd,
        '/opt/homebrew/bin/' + cmd,
        path.join(home, '.npm-global', 'bin', cmd),
      ];

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }

  return null;
}

// ── Known code agents ─────────────────────────────────────────────────

interface KnownAgent {
  name: string;
  label: string;
  command: string;
  argsTemplate: string[];
  promptVia: 'arg' | 'stdin';
  whichCmd: string; // command to check existence
}

const KNOWN_AGENTS: KnownAgent[] = [
  {
    name: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    argsTemplate: ['-p', '{{prompt}}'],
    promptVia: 'arg',
    whichCmd: 'claude',
  },
  {
    name: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    argsTemplate: ['exec', '--dangerously-bypass-approvals-and-sandbox', '{{prompt}}'],
    promptVia: 'arg',
    whichCmd: 'codex',
  },
  {
    name: 'aider',
    label: 'Aider',
    command: 'aider',
    argsTemplate: ['--message', '{{prompt}}'],
    promptVia: 'arg',
    whichCmd: 'aider',
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    argsTemplate: ['-p', '{{prompt}}'],
    promptVia: 'arg',
    whichCmd: 'gemini',
  },
];

// ── Load existing config ──────────────────────────────────────────────

interface TierConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ExistingConfig {
  name?: string;
  llm?: { provider?: string; model?: string; baseUrl?: string; default?: TierConfig; strong?: TierConfig; fast?: TierConfig; embeddings?: TierConfig; local?: TierConfig };
  telegram?: { token?: string; enabled?: boolean };
  discord?: { token?: string; enabled?: boolean };
  whatsapp?: { enabled?: boolean; dataPath?: string };
  matrix?: { homeserverUrl?: string; accessToken?: string; userId?: string; enabled?: boolean };
  signal?: { apiUrl?: string; phoneNumber?: string; enabled?: boolean };
  security?: { ownerUserId?: string };
  search?: { provider?: string; apiKey?: string; baseUrl?: string };
  email?: { accounts?: Array<{ name?: string; provider?: string; imap?: { host?: string; port?: number }; smtp?: { host?: string; port?: number }; auth?: { user?: string; pass?: string }; microsoft?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string } }>; provider?: string; imap?: { host?: string; port?: number }; smtp?: { host?: string; port?: number }; auth?: { user?: string; pass?: string }; microsoft?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string } };
  codeSandbox?: { enabled?: boolean; allowedLanguages?: string[] };
  codeAgents?: { enabled?: boolean; agents?: { name: string; command: string; argsTemplate: string[]; promptVia?: string }[]; forge?: { provider?: string; github?: { token?: string }; gitlab?: { token?: string } } };
  calendar?: { provider?: string; microsoft?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string } };
  proxmox?: { baseUrl?: string; tokenId?: string; tokenSecret?: string; verifyTls?: boolean; defaultNode?: string };
  proxmoxBackup?: { baseUrl?: string; tokenId?: string; tokenSecret?: string; maxAgeHours?: number; verifyTls?: boolean };
  unifi?: { baseUrl?: string; apiKey?: string; username?: string; password?: string; site?: string; verifyTls?: boolean };
  homeassistant?: { baseUrl?: string; accessToken?: string; verifyTls?: boolean };
  contacts?: { provider?: string; carddav?: { serverUrl?: string; username?: string; password?: string }; google?: { clientId?: string; clientSecret?: string; refreshToken?: string }; microsoft?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string } };
  docker?: { socketPath?: string; host?: string };
  bmw?: { clientId?: string };
  routing?: { apiKey?: string };
  youtube?: { apiKey?: string; supadata?: { enabled?: boolean; apiKey?: string } };
  energy?: { gridName?: string; gridUsageCt?: number; gridLossCt?: number; gridCapacityFee?: number; gridMeterFee?: number };
  storage?: { path?: string; backend?: string; connectionString?: string };
  fileStore?: { backend?: string; basePath?: string; s3Endpoint?: string; s3Bucket?: string; s3AccessKey?: string; s3SecretKey?: string };
  cluster?: { enabled?: boolean; nodeId?: string; role?: string; redisUrl?: string; token?: string };
}

function loadExistingConfig(projectRoot: string): {
  config: ExistingConfig;
  env: Record<string, string>;
  shellEnabled: boolean;
  writeInGroups: boolean;
  rateLimit: number;
  codeSandboxEnabled: boolean;
  webUiEnabled: boolean;
  multiModelTiers: Record<string, TierConfig>;
} {
  const config: ExistingConfig = {};
  const env: Record<string, string> = {};
  let shellEnabled = false;
  let writeInGroups = false;
  let rateLimit = 30;

  // Load config/default.yml
  const configPath = path.join(projectRoot, 'config', 'default.yml');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        Object.assign(config, parsed);
      }
    } catch { /* ignore parse errors */ }
  }

  // Load .env
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
      }
    } catch { /* ignore */ }
  }

  // Check security settings from rules
  const rulesPath = path.join(projectRoot, 'config', 'rules', 'default-rules.yml');
  if (fs.existsSync(rulesPath)) {
    try {
      const rulesContent = yaml.load(fs.readFileSync(rulesPath, 'utf-8')) as any;
      if (rulesContent?.rules) {
        shellEnabled = rulesContent.rules.some(
          (r: any) => r.id === 'allow-owner-admin' && r.effect === 'allow',
        );
        // Check if write-in-DM rule has been removed (= write everywhere)
        const writeDmRule = rulesContent.rules.find(
          (r: any) => r.id === 'allow-write-for-dm' || r.id === 'allow-write-all',
        );
        if (writeDmRule?.id === 'allow-write-all') {
          writeInGroups = true;
        }
        // Check rate limit
        const rlRule = rulesContent.rules.find(
          (r: any) => r.id === 'rate-limit-write',
        );
        if (rlRule?.rateLimit?.maxInvocations) {
          rateLimit = rlRule.rateLimit.maxInvocations;
        }
      }
    } catch { /* ignore */ }
  }

  const codeSandboxEnabled = !!(config as any).codeSandbox?.enabled;
  const webUiEnabled = (config as any).api?.webUi !== false;

  // Detect existing multi-model tiers
  const llm = config.llm as Record<string, any> | undefined;
  const multiModelTiers: Record<string, TierConfig> = {};
  if (llm) {
    for (const tier of ['strong', 'fast', 'embeddings', 'local'] as const) {
      if (llm[tier]?.provider && llm[tier]?.model) {
        multiModelTiers[tier] = llm[tier];
      }
    }
    // Also check if config is already in nested format (llm.default exists)
    if (llm.default?.provider) {
      config.llm = { ...config.llm, provider: llm.default.provider, model: llm.default.model, baseUrl: llm.default.baseUrl };
    }
  }

  return { config, env, shellEnabled, writeInGroups, rateLimit, codeSandboxEnabled, webUiEnabled, multiModelTiers };
}

// ── Main setup command ────────────────────────────────────────────────

export async function setupCommand(): Promise<void> {
  const rl = createInterface({ input, output });

  // Resolve project root (two levels up from packages/cli/src or dist)
  const projectRoot = process.cwd();

  // Load existing configuration for defaults
  const existing = loadExistingConfig(projectRoot);
  const hasExisting = Object.keys(existing.config).length > 0;

  try {
    printBanner();

    if (hasExisting) {
      console.log(
        `${CYAN}Existing configuration found — press Enter to keep current values.${RESET}\n` +
        `${DIM}Only change what you need to update.${RESET}\n`,
      );
    } else {
      console.log(
        `${CYAN}Welcome to the Alfred setup wizard!${RESET}\n` +
        `${DIM}This will walk you through configuring your AI assistant.${RESET}\n` +
        `${DIM}Press Enter to accept defaults shown in [brackets].${RESET}\n`,
      );
    }

    // ── 1. Bot name ───────────────────────────────────────────────
    const botName = await askWithDefault(rl, 'What should your bot be called?', existing.config.name ?? 'Alfred');

    // ── 2. LLM Provider ──────────────────────────────────────────
    const existingProviderIdx = existing.config.llm?.provider
      ? PROVIDERS.findIndex(p => p.name === existing.config.llm?.provider)
      : -1;
    const defaultProviderChoice = existingProviderIdx >= 0 ? existingProviderIdx + 1 : 1;

    console.log(`\n${bold('Which LLM provider would you like to use?')}`);
    for (let i = 0; i < PROVIDERS.length; i++) {
      const current = i === existingProviderIdx ? ` ${dim('(current)')}` : '';
      console.log(`  ${cyan(String(i + 1) + ')')} ${PROVIDERS[i].label}${current}`);
    }
    const providerChoice = await askNumber(rl, '> ', 1, PROVIDERS.length, defaultProviderChoice);
    const provider = PROVIDERS[providerChoice - 1];
    console.log(`  ${green('>')} Selected: ${bold(provider.label)}`);

    // ── 3. API key ───────────────────────────────────────────────
    let apiKey = '';
    const existingApiKey = existing.env[provider.envKeyName] ?? '';
    if (provider.needsApiKey) {
      console.log('');
      if (existingApiKey) {
        apiKey = await askWithDefault(
          rl,
          `${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)} API key`,
          existingApiKey,
        );
      } else {
        apiKey = await askRequired(
          rl,
          `Enter your ${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)} API key`,
        );
      }
      console.log(`  ${green('>')} API key set: ${dim(maskKey(apiKey))}`);
    }

    // ── 3b. Base URL (for providers with configurable endpoints) ──
    let baseUrl = provider.baseUrl ?? '';
    const providersWithBaseUrl = ['ollama', 'openwebui', 'openai', 'openrouter', 'google'];
    if (providersWithBaseUrl.includes(provider.name)) {
      const existingUrl = existing.config.llm?.baseUrl ?? existing.env['ALFRED_LLM_BASE_URL'] ?? '';
      const defaultUrl = existingUrl || provider.baseUrl || '';
      if (defaultUrl) {
        const urlPromptLabels: Record<string, string> = {
          ollama: 'Ollama URL (use a remote address if Ollama runs on another machine)',
          openwebui: 'OpenWebUI URL',
          openai: 'OpenAI-compatible API URL (leave default for official API)',
          openrouter: 'OpenRouter API URL',
          google: 'Google Gemini API URL (leave default for official API)',
        };
        console.log('');
        baseUrl = await askWithDefault(
          rl,
          urlPromptLabels[provider.name] ?? 'API Base URL',
          defaultUrl.replace(/\/+$/, ''),
        );
        baseUrl = baseUrl.replace(/\/+$/, '');
        console.log(`  ${green('>')} URL: ${dim(baseUrl)}`);
      }
    }

    // ── 4. Model ─────────────────────────────────────────────────
    const existingModel = existing.config.llm?.model ?? provider.defaultModel;
    console.log('');
    let model: string;

    const dynamicModels = await getModels(provider.name, apiKey, baseUrl);
    const allModels = mergeModels(dynamicModels, provider.models ?? []);

    if (allModels.length > 0) {
      console.log(`${bold('Available models:')}`);
      for (let i = 0; i < allModels.length; i++) {
        const m = allModels[i];
        const label = m.desc ?? m.name ?? '';
        const marker = m.id === existingModel ? ` ${green('(current)')}` : '';
        console.log(`  ${cyan(`${i + 1})`)} ${m.id}${label ? ` ${dim(`— ${label}`)}` : ''}${marker}`);
      }
      console.log(`  ${cyan(`${allModels.length + 1})`)} ${dim('Other (enter manually)')}`);
      const choice = await askWithDefault(rl, 'Choose model', '1');
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < allModels.length) {
        model = allModels[idx].id;
      } else {
        model = await askWithDefault(rl, 'Model ID', existingModel);
      }
    } else {
      model = await askWithDefault(rl, 'Which model?', existingModel);
    }

    // ── 4b. Additional model tiers (multi-model) ──────────────
    const hasExistingTiers = Object.keys(existing.multiModelTiers).length > 0;
    const multiModelDefault = hasExistingTiers ? 'Y/n' : 'y/N';
    console.log(`\n${bold('Configure additional model tiers for specialized tasks?')}`);
    console.log(`${dim('Optional: use different models for complex tasks, quick replies, embeddings, or offline.')}`);
    const multiModelAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${multiModelDefault}] `)}`)
    ).trim().toLowerCase();
    const enableMultiModel = multiModelAnswer === '' ? hasExistingTiers : (multiModelAnswer === 'y' || multiModelAnswer === 'yes');

    interface TierEntry { provider: string; model: string; apiKey?: string; baseUrl?: string }
    const configuredTiers: Record<string, TierEntry> = {};

    if (enableMultiModel) {
      const tierDefs: { key: string; label: string; hint: string; defaultModel: string }[] = [
        { key: 'strong', label: 'Strong', hint: 'complex reasoning, coding, long documents', defaultModel: 'claude-opus-4-20250514' },
        { key: 'fast', label: 'Fast', hint: 'quick responses, simple tasks', defaultModel: 'claude-haiku-4-5-20251001' },
        { key: 'embeddings', label: 'Embeddings', hint: 'semantic search & memory', defaultModel: 'text-embedding-3-small' },
        { key: 'local', label: 'Local', hint: 'offline fallback via Ollama', defaultModel: 'llama3.2' },
      ];

      for (const tier of tierDefs) {
        const existingTier = existing.multiModelTiers[tier.key];
        const hasExisting = !!existingTier?.model;

        console.log(`\n  ${bold(`${tier.label} model`)} ${dim(`(${tier.hint})`)}`);
        if (hasExisting) {
          console.log(`  ${dim(`Current: ${existingTier!.provider}/${existingTier!.model}`)}`);
        }

        // Provider: default to same as main provider, or existing tier provider
        const tierProviderDefault = existingTier?.provider ?? provider.name;
        const tierProviderNames = PROVIDERS.map(p => p.name).join(', ');
        console.log(`  ${dim(`Providers: ${tierProviderNames}`)}`);
        const tierProviderAnswer = (
          await rl.question(`  ${YELLOW}Provider: ${RESET}${dim(`[${tierProviderDefault}] `)}`)
        ).trim();
        const tierProviderInput = tierProviderAnswer || tierProviderDefault;

        // Allow skipping by entering empty provider when no existing tier
        if (!tierProviderInput && !hasExisting) {
          console.log(`    ${dim('Skipped.')}`);
          continue;
        }
        const tierProvider = tierProviderInput;

        // API key: only ask if different provider than default
        let tierApiKey: string | undefined;
        let tierBaseUrl: string | undefined;
        if (tierProvider !== provider.name) {
          const existingTierKey = existingTier?.apiKey ?? existing.env[`ALFRED_LLM_${tier.key.toUpperCase()}_API_KEY`] ?? '';
          if (existingTierKey) {
            tierApiKey = await askWithDefault(rl, `  API key for ${tierProvider}`, existingTierKey);
          } else {
            const needsKey = PROVIDERS.find(p => p.name === tierProvider)?.needsApiKey ?? true;
            if (needsKey) {
              tierApiKey = await askRequired(rl, `  API key for ${tierProvider}`);
            }
          }
          // Base URL for local/ollama/openwebui
          const localProviders = ['ollama', 'openwebui'];
          if (localProviders.includes(tierProvider)) {
            const existingUrl = existingTier?.baseUrl ?? '';
            const defaultUrl = existingUrl || PROVIDERS.find(p => p.name === tierProvider)?.baseUrl || '';
            if (defaultUrl) {
              tierBaseUrl = await askWithDefault(rl, `  ${tierProvider} URL`, defaultUrl);
            }
          }
        }

        // Resolve the effective key & url for model discovery
        const effectiveTierKey = tierApiKey ?? (tierProvider === provider.name ? apiKey : undefined);
        const effectiveTierUrl = tierBaseUrl ?? (tierProvider === provider.name ? baseUrl : undefined);
        const tierProviderDef = PROVIDERS.find(p => p.name === tierProvider);

        // Fetch dynamic models for this tier's provider
        const tierDynamic = await getModels(tierProvider, effectiveTierKey, effectiveTierUrl);
        const tierAllModels = mergeModels(tierDynamic, tierProviderDef?.models ?? []);

        let tierModel: string;
        if (tierAllModels.length > 0) {
          console.log(`  ${bold('Available models:')}`);
          for (let i = 0; i < tierAllModels.length; i++) {
            const m = tierAllModels[i];
            const label = m.desc ?? m.name ?? '';
            const marker = m.id === existingTier?.model ? ` ${green('(current)')}` : '';
            console.log(`    ${cyan(`${i + 1})`)} ${m.id}${label ? ` ${dim(`— ${label}`)}` : ''}${marker}`);
          }
          console.log(`    ${cyan(`${tierAllModels.length + 1})`)} ${dim('Other (enter manually)')}`);
          console.log(`    ${cyan('0)')} ${dim('Skip this tier')}`);
          const tierChoice = (
            await rl.question(`  ${YELLOW}> ${RESET}${hasExisting ? dim(`[${existingTier!.model}] `) : ''}`)
          ).trim();
          if (tierChoice === '0') {
            console.log(`    ${dim('Skipped.')}`);
            continue;
          }
          const tierIdx = parseInt(tierChoice, 10) - 1;
          if (tierIdx >= 0 && tierIdx < tierAllModels.length) {
            tierModel = tierAllModels[tierIdx].id;
          } else if (!tierChoice && hasExisting) {
            tierModel = existingTier!.model!;
          } else {
            tierModel = await askWithDefault(rl, '  Model ID', hasExisting ? existingTier!.model! : tier.defaultModel);
          }
        } else {
          console.log(`  ${dim('Press Enter to skip.')}`);
          const tierModelAnswer = (
            await rl.question(`  ${YELLOW}Model: ${RESET}${hasExisting ? dim(`[${existingTier!.model}] `) : ''}`)
          ).trim();
          tierModel = tierModelAnswer || (hasExisting ? existingTier!.model! : '');
          if (!tierModel) {
            console.log(`    ${dim('Skipped.')}`);
            continue;
          }
        }

        configuredTiers[tier.key] = {
          provider: tierProvider,
          model: tierModel,
          ...(tierApiKey ? { apiKey: tierApiKey } : {}),
          ...(tierBaseUrl ? { baseUrl: tierBaseUrl } : {}),
        };
        console.log(`    ${green('>')} ${tier.label}: ${bold(tierProvider)}/${bold(tierModel)}`);
      }

      if (Object.keys(configuredTiers).length === 0) {
        console.log(`\n  ${dim('No additional tiers configured — using single model.')}`);
      }
    } else {
      console.log(`  ${dim('Using single model for all tasks.')}`);
    }

    // ── 5. Web Search ──────────────────────────────────────────
    const searchProviders = ['brave', 'tavily', 'duckduckgo', 'searxng'] as const;
    const existingSearchProvider = existing.config.search?.provider ?? existing.env['ALFRED_SEARCH_PROVIDER'] ?? '';
    const existingSearchIdx = searchProviders.indexOf(existingSearchProvider as typeof searchProviders[number]);
    const defaultSearchChoice = existingSearchIdx >= 0 ? existingSearchIdx + 1 : 0;

    console.log(`\n${bold('Web Search provider (for searching the internet):')}`);
    const searchLabels = [
      'Brave Search — recommended, free tier (2,000/month)',
      'Tavily — built for AI agents, free tier (1,000/month)',
      'DuckDuckGo — free, no API key needed',
      'SearXNG — self-hosted, no API key needed',
    ];
    const mark = (i: number) => existingSearchIdx === i ? ` ${dim('(current)')}` : '';
    console.log(`  ${cyan('0)')} None (disable web search)${existingSearchIdx === -1 && existingSearchProvider === '' ? ` ${dim('(current)')}` : ''}`);
    for (let i = 0; i < searchLabels.length; i++) {
      console.log(`  ${cyan(String(i + 1) + ')')} ${searchLabels[i]}${mark(i)}`);
    }
    const searchChoice = await askNumber(rl, '> ', 0, searchProviders.length, defaultSearchChoice);

    let searchProvider: typeof searchProviders[number] | undefined;
    let searchApiKey = '';
    let searchBaseUrl = '';

    if (searchChoice >= 1 && searchChoice <= searchProviders.length) {
      searchProvider = searchProviders[searchChoice - 1];
    }

    if (searchProvider === 'brave') {
      const existingKey = existing.env['ALFRED_SEARCH_API_KEY'] ?? '';
      if (existingKey) {
        searchApiKey = await askWithDefault(rl, '  Brave Search API key', existingKey);
      } else {
        console.log(`  ${dim('Get your free API key at: https://brave.com/search/api/')}`);
        searchApiKey = await askRequired(rl, '  Brave Search API key');
      }
      console.log(`  ${green('>')} Brave Search: ${dim(maskKey(searchApiKey))}`);
    } else if (searchProvider === 'tavily') {
      const existingKey = existing.env['ALFRED_SEARCH_API_KEY'] ?? '';
      if (existingKey) {
        searchApiKey = await askWithDefault(rl, '  Tavily API key', existingKey);
      } else {
        console.log(`  ${dim('Get your free API key at: https://tavily.com/')}`);
        searchApiKey = await askRequired(rl, '  Tavily API key');
      }
      console.log(`  ${green('>')} Tavily: ${dim(maskKey(searchApiKey))}`);
    } else if (searchProvider === 'duckduckgo') {
      console.log(`  ${green('>')} DuckDuckGo: ${dim('no API key needed')}`);
    } else if (searchProvider === 'searxng') {
      const existingSearxUrl = existing.config.search?.baseUrl ?? existing.env['ALFRED_SEARCH_BASE_URL'] ?? 'http://localhost:8080';
      searchBaseUrl = await askWithDefault(rl, '  SearXNG URL', existingSearxUrl);
      searchBaseUrl = searchBaseUrl.replace(/\/+$/, '');
      console.log(`  ${green('>')} SearXNG: ${dim(searchBaseUrl)}`);
    } else {
      console.log(`  ${dim('Web search disabled — you can configure it later.')}`);
    }

    // ── 6. Platforms ─────────────────────────────────────────────
    // Determine which platforms are currently enabled
    const currentlyEnabled: number[] = [];
    for (let i = 0; i < PLATFORMS.length; i++) {
      const p = PLATFORMS[i];
      const ec = existing.config as Record<string, any>;
      if (ec[p.configKey]?.enabled) {
        currentlyEnabled.push(i + 1);
      }
    }
    const currentDefault = currentlyEnabled.length > 0
      ? currentlyEnabled.join(',')
      : '';

    console.log(`\n${bold('Which messaging platforms do you want to enable?')}`);
    console.log(`${dim('(Enter comma-separated numbers, e.g. 1,3)')}`);
    for (let i = 0; i < PLATFORMS.length; i++) {
      const enabled = currentlyEnabled.includes(i + 1) ? ` ${dim('(enabled)')}` : '';
      console.log(`  ${cyan(String(i + 1) + ')')} ${PLATFORMS[i].label}${enabled}`);
    }
    console.log(`  ${cyan('0)')} None (configure later)`);

    const platformInput = (await rl.question(
      `${YELLOW}> ${RESET}${currentDefault ? dim(`[${currentDefault}] `) : ''}`
    )).trim();

    const selectedPlatforms: PlatformDef[] = [];
    const effectiveInput = platformInput || currentDefault;
    if (effectiveInput && effectiveInput !== '0') {
      const nums = effectiveInput.split(',').map((s) => parseInt(s.trim(), 10));
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
        // Use existing value from .env or config as default
        const existingVal = existing.env[cred.envKey] ?? '';
        let value: string;
        if (existingVal) {
          value = await askWithDefault(rl, `  ${cred.prompt}`, existingVal);
        } else if (cred.defaultValue) {
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

    // ── 7. Email configuration (multi-account) ──────────────────
    // Detect existing accounts from both flat and accounts-array format
    const existingAccounts = existing.config.email?.accounts ?? [];
    const existingFirstAccount = existingAccounts[0];
    const existingEmailUser = existingFirstAccount?.auth?.user ?? existing.config.email?.auth?.user ?? existing.env['ALFRED_EMAIL_USER'] ?? '';
    const existingEmailProvider = existingFirstAccount?.provider ?? existing.config.email?.provider ?? existing.env['ALFRED_EMAIL_PROVIDER'] ?? '';
    const hasEmail = existingAccounts.length > 0 || !!existingEmailUser || existingEmailProvider === 'microsoft';
    const emailDefault = hasEmail ? 'Y/n' : 'y/N';
    console.log(`\n${bold('Email access (read & send emails)?')}`);
    console.log(`${dim('Works with Gmail, Outlook, Microsoft 365, or any IMAP/SMTP provider. Supports multiple accounts.')}`);
    const emailAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${emailDefault}] `)}`)
    ).trim().toLowerCase();
    const enableEmail = emailAnswer === '' ? hasEmail : (emailAnswer === 'y' || emailAnswer === 'yes');

    interface EmailAccountSetup {
      name: string;
      provider: 'imap-smtp' | 'microsoft';
      user: string;
      pass: string;
      imapHost: string;
      imapPort: number;
      smtpHost: string;
      smtpPort: number;
      msClientId: string;
      msClientSecret: string;
      msTenantId: string;
      msRefreshToken: string;
    }

    const emailAccounts: EmailAccountSetup[] = [];

    const emailImapPresets: Record<string, { imap: string; smtp: string }> = {
      'gmail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
      'googlemail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
      'outlook.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com' },
      'hotmail.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com' },
      'live.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com' },
      'yahoo.com': { imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com' },
      'icloud.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com' },
      'me.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com' },
      'gmx.de': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
      'gmx.net': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
      'web.de': { imap: 'imap.web.de', smtp: 'smtp.web.de' },
      'posteo.de': { imap: 'posteo.de', smtp: 'posteo.de' },
      'mailbox.org': { imap: 'imap.mailbox.org', smtp: 'smtp.mailbox.org' },
      'protonmail.com': { imap: '127.0.0.1', smtp: '127.0.0.1' },
      'proton.me': { imap: '127.0.0.1', smtp: '127.0.0.1' },
    };

    const configureEmailAccount = async (accountName: string, existingAccount?: typeof existingFirstAccount): Promise<EmailAccountSetup> => {
      const acct: EmailAccountSetup = {
        name: accountName,
        provider: 'imap-smtp',
        user: '', pass: '',
        imapHost: '', imapPort: 993,
        smtpHost: '', smtpPort: 587,
        msClientId: '', msClientSecret: '', msTenantId: '', msRefreshToken: '',
      };

      const existAcctProvider = existingAccount?.provider ?? '';
      const emailProviderLabels = [
        'IMAP/SMTP (classic)',
        'Microsoft 365 (Graph API, OAuth)',
      ];
      const existingProviderIdx = existAcctProvider === 'microsoft' ? 1 : 0;
      console.log('');
      for (let i = 0; i < emailProviderLabels.length; i++) {
        const current = i === existingProviderIdx ? ` ${dim('(current)')}` : '';
        console.log(`  ${cyan(`${i + 1})`)} ${emailProviderLabels[i]}${current}`);
      }
      const epChoice = (await rl.question(`${YELLOW}> ${RESET}${dim(`[${existingProviderIdx + 1}] `)}`)).trim();
      const epIdx = epChoice === '' ? existingProviderIdx : parseInt(epChoice, 10) - 1;
      acct.provider = epIdx === 1 ? 'microsoft' : 'imap-smtp';

      if (acct.provider === 'microsoft') {
        const calMs = existing.config.calendar?.microsoft;
        const existMsClientId = existingAccount?.microsoft?.clientId ?? existing.env['ALFRED_MICROSOFT_EMAIL_CLIENT_ID'] ?? '';
        const existMsTenantId = existingAccount?.microsoft?.tenantId ?? existing.env['ALFRED_MICROSOFT_EMAIL_TENANT_ID'] ?? '';
        const existMsRefreshToken = existingAccount?.microsoft?.refreshToken ?? existing.env['ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN'] ?? '';

        if (calMs && !existMsClientId) {
          console.log(`  ${green('>')} Microsoft Calendar already configured — credentials will be shared.`);
          console.log(`  ${dim('The same Azure App Registration will be used for Mail + Calendar.')}`);
          console.log(`  ${dim('Ensure the app has Mail.ReadWrite and Mail.Send scopes.')}`);
        } else {
          console.log(`  ${dim('Azure Portal → App Registrations → your app → Mail.ReadWrite + Mail.Send scopes')}`);
          acct.msClientId = await askWithDefault(rl, '  Client ID', existMsClientId);
          if (!acct.msClientId) acct.msClientId = await askRequired(rl, '  Client ID');

          const existMsSecret = existing.env['ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET'] ?? '';
          acct.msClientSecret = await askWithDefault(rl, '  Client Secret', existMsSecret);
          if (!acct.msClientSecret) acct.msClientSecret = await askRequired(rl, '  Client Secret');

          acct.msTenantId = await askWithDefault(rl, '  Tenant ID', existMsTenantId);
          if (!acct.msTenantId) acct.msTenantId = await askRequired(rl, '  Tenant ID');

          console.log(`  ${dim('Tipp: Du kannst `alfred auth microsoft` ausführen um den Refresh Token automatisch zu holen.')}`);
          acct.msRefreshToken = await askWithDefault(rl, '  Refresh Token', existMsRefreshToken);
          if (!acct.msRefreshToken) acct.msRefreshToken = await askRequired(rl, '  Refresh Token');
        }

        console.log(`  ${green('>')} Email [${accountName}]: Microsoft 365 (Graph API)`);
      } else {
        const existUser = existingAccount?.auth?.user ?? '';
        console.log('');
        acct.user = await askWithDefault(rl, '  Email address', existUser || '');
        if (!acct.user) {
          acct.user = await askRequired(rl, '  Email address');
        }

        const existPass = existingAccount?.auth?.pass ?? existing.env['ALFRED_EMAIL_PASS'] ?? '';
        if (existPass) {
          acct.pass = await askWithDefault(rl, '  Password / App password', existPass);
        } else {
          console.log(`  ${dim('For Gmail: use an App Password (not your regular password)')}`);
          console.log(`  ${dim('  → Google Account → Security → 2-Step → App passwords')}`);
          acct.pass = await askRequired(rl, '  Password / App password');
        }

        const domain = acct.user.split('@')[1]?.toLowerCase() ?? '';
        const preset = emailImapPresets[domain];
        const defaultImap = existingAccount?.imap?.host ?? preset?.imap ?? `imap.${domain}`;
        const defaultSmtp = existingAccount?.smtp?.host ?? preset?.smtp ?? `smtp.${domain}`;
        const defaultImapPort = existingAccount?.imap?.port ?? 993;
        const defaultSmtpPort = existingAccount?.smtp?.port ?? 587;

        if (preset) {
          console.log(`  ${green('>')} Detected ${domain} — using preset server settings`);
        }

        acct.imapHost = await askWithDefault(rl, '  IMAP server', defaultImap);
        const imapPortStr = await askWithDefault(rl, '  IMAP port', String(defaultImapPort));
        acct.imapPort = parseInt(imapPortStr, 10) || 993;

        acct.smtpHost = await askWithDefault(rl, '  SMTP server', defaultSmtp);
        const smtpPortStr = await askWithDefault(rl, '  SMTP port', String(defaultSmtpPort));
        acct.smtpPort = parseInt(smtpPortStr, 10) || 587;

        console.log(`  ${green('>')} Email [${accountName}]: ${dim(acct.user)} via ${dim(acct.imapHost)}`);
      }

      return acct;
    };

    if (enableEmail) {
      // Configure first account (name: default)
      const firstExisting = existingFirstAccount ?? (existing.config.email?.auth ? {
        provider: existing.config.email.provider,
        auth: existing.config.email.auth,
        imap: existing.config.email.imap,
        smtp: existing.config.email.smtp,
        microsoft: existing.config.email.microsoft,
      } : undefined);
      emailAccounts.push(await configureEmailAccount('default', firstExisting as typeof existingFirstAccount));

      // Add more accounts?
      let addMore = true;
      while (addMore) {
        const moreAnswer = (
          await rl.question(`\n  ${bold('Add another email account?')} ${dim('[y/N]')} `)
        ).trim().toLowerCase();
        if (moreAnswer === 'y' || moreAnswer === 'yes') {
          const nameAnswer = (await rl.question(`  ${bold('Account name:')} `)).trim();
          const name = nameAnswer || `account${emailAccounts.length + 1}`;
          const existAcct = existingAccounts.find(a => a.name === name);
          emailAccounts.push(await configureEmailAccount(name, existAcct));
        } else {
          addMore = false;
        }
      }
    } else {
      console.log(`  ${dim('Email disabled — you can configure it later.')}`);
    }

    // ── 8. Speech-to-text (voice messages) ──────────────────────
    const speechProviders = ['openai', 'groq'] as const;
    const existingSpeechProvider = (existing.config as Record<string, any>).speech?.provider ?? existing.env['ALFRED_SPEECH_PROVIDER'] ?? '';
    const existingSpeechIdx = speechProviders.indexOf(existingSpeechProvider as typeof speechProviders[number]);
    const defaultSpeechChoice = existingSpeechIdx >= 0 ? existingSpeechIdx + 1 : 0;

    console.log(`\n${bold('Voice message transcription (Speech-to-Text via Whisper)?')}`);
    console.log(`${dim('Transcribes voice messages from Telegram, Discord, etc.')}`);
    const speechLabels = [
      'OpenAI Whisper — best quality',
      'Groq Whisper — fast & free',
    ];
    console.log(`  ${cyan('0)')} None (disable voice transcription)${existingSpeechIdx === -1 ? ` ${dim('(current)')}` : ''}`);
    for (let i = 0; i < speechLabels.length; i++) {
      const cur = existingSpeechIdx === i ? ` ${dim('(current)')}` : '';
      console.log(`  ${cyan(String(i + 1) + ')')} ${speechLabels[i]}${cur}`);
    }
    const speechChoice = await askNumber(rl, '> ', 0, speechProviders.length, defaultSpeechChoice);

    let speechProvider: typeof speechProviders[number] | undefined;
    let speechApiKey = '';
    let speechBaseUrl = '';

    if (speechChoice >= 1 && speechChoice <= speechProviders.length) {
      speechProvider = speechProviders[speechChoice - 1];
    }

    if (speechProvider === 'openai') {
      const existingKey = existing.env['ALFRED_SPEECH_API_KEY'] ?? '';
      if (existingKey) {
        speechApiKey = await askWithDefault(rl, '  OpenAI API key (for Whisper)', existingKey);
      } else {
        console.log(`  ${dim('Uses your OpenAI API key for Whisper transcription.')}`);
        speechApiKey = await askRequired(rl, '  OpenAI API key');
      }
      console.log(`  ${green('>')} OpenAI Whisper: ${dim(maskKey(speechApiKey))}`);
    } else if (speechProvider === 'groq') {
      const existingKey = existing.env['ALFRED_SPEECH_API_KEY'] ?? '';
      if (existingKey) {
        speechApiKey = await askWithDefault(rl, '  Groq API key', existingKey);
      } else {
        console.log(`  ${dim('Get your free API key at: https://console.groq.com/')}`);
        speechApiKey = await askRequired(rl, '  Groq API key');
      }
      const existingUrl = existing.env['ALFRED_SPEECH_BASE_URL'] ?? '';
      if (existingUrl) {
        speechBaseUrl = await askWithDefault(rl, '  Groq API URL', existingUrl);
      }
      console.log(`  ${green('>')} Groq Whisper: ${dim(maskKey(speechApiKey))}`);
    } else {
      console.log(`  ${dim('Voice transcription disabled — you can configure it later.')}`);
    }

    // ── 8a. Text-to-Speech (voice responses) ─────────────────
    let ttsEnabled = false;
    let ttsVoice = 'alloy';

    if (speechProvider) {
      const existingTTS = (existing.config as Record<string, any>).speech?.ttsEnabled ?? false;
      const ttsDefault = existingTTS ? 'Y/n' : 'y/N';
      console.log(`\n${bold('Voice responses (Text-to-Speech)?')}`);
      console.log(`${dim('Alfred can reply as a voice message when the user asks for it.')}`);
      const ttsAnswer = (
        await rl.question(`${YELLOW}> ${RESET}${dim(`[${ttsDefault}] `)}`)
      ).trim().toLowerCase();
      ttsEnabled = ttsAnswer === '' ? existingTTS : (ttsAnswer === 'y' || ttsAnswer === 'yes');

      if (ttsEnabled) {
        const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const existingVoice = (existing.config as Record<string, any>).speech?.ttsVoice ?? 'alloy';
        const existingVoiceIdx = voices.indexOf(existingVoice);
        const defaultVoiceChoice = existingVoiceIdx >= 0 ? existingVoiceIdx + 1 : 1;

        console.log(`\n  ${bold('Which voice?')}`);
        for (let i = 0; i < voices.length; i++) {
          const cur = existingVoiceIdx === i ? ` ${dim('(current)')}` : '';
          console.log(`  ${cyan(String(i + 1) + ')')} ${voices[i]}${cur}`);
        }
        const voiceChoice = await askNumber(rl, '  > ', 1, voices.length, defaultVoiceChoice);
        ttsVoice = voices[voiceChoice - 1];
        console.log(`  ${green('>')} TTS voice: ${bold(ttsVoice)}`);
      } else {
        console.log(`  ${dim('Voice responses disabled.')}`);
      }
    }

    // ── 8b. Code Sandbox (Python/JavaScript execution) ────────
    const sandboxDefault = existing.codeSandboxEnabled ? 'Y/n' : 'y/N';
    console.log(`\n${bold('Code Sandbox (execute Python/JavaScript in a sandboxed environment)?')}`);
    console.log(`${dim('Enables code execution for calculations, data processing, PDF generation, charts, etc.')}`);
    const sandboxAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${sandboxDefault}] `)}`)
    ).trim().toLowerCase();
    const enableSandbox = sandboxAnswer === '' ? existing.codeSandboxEnabled : (sandboxAnswer === 'y' || sandboxAnswer === 'yes');
    if (enableSandbox) {
      console.log(`  ${green('>')} Code Sandbox ${bold('enabled')} (JavaScript + Python)`);
    } else {
      console.log(`  ${dim('Code Sandbox disabled — you can enable it later in config/default.yml.')}`);
    }

    // ── 8c. Code Agents (auto-detect CLI tools) ──────────────
    console.log(`\n${bold('Code Agents (CLI-based coding agents for automated tasks)?')}`);
    console.log(`${dim('Scanning for known coding agents on this system...')}`);

    const detectedAgents: (KnownAgent & { resolvedPath?: string })[] = [];

    for (const agent of KNOWN_AGENTS) {
      const resolved = findCommand(agent.whichCmd);
      if (resolved) {
        detectedAgents.push({ ...agent, resolvedPath: resolved });
        console.log(`  ${green('✓')} ${bold(agent.label)} ${dim(`(${resolved})`)}`);
      } else {
        console.log(`  ${dim('·')} ${dim(agent.label)} ${dim('— not found')}`);
      }
    }

    // Check existing agents that aren't in KNOWN_AGENTS (custom config)
    const existingAgents = existing.config.codeAgents?.agents ?? [];
    const customAgents = existingAgents.filter(
      (a) => !KNOWN_AGENTS.some((k) => k.name === a.name),
    );
    for (const a of customAgents) {
      console.log(`  ${green('✓')} ${bold(a.name)} ${dim(`(${a.command}) — from existing config`)}`);
    }

    interface SelectedAgent {
      name: string;
      command: string;
      argsTemplate: string[];
      promptVia: 'arg' | 'stdin';
    }

    let selectedAgents: SelectedAgent[] = [];

    if (detectedAgents.length === 0 && customAgents.length === 0) {
      console.log(`\n  ${dim('No coding agents found. You can add them manually in config/default.yml later.')}`);
    } else {
      const allCandidates = [
        ...detectedAgents.map((a) => ({ name: a.name, command: a.resolvedPath ?? a.command, argsTemplate: a.argsTemplate, promptVia: a.promptVia, label: a.label, detected: true })),
        ...customAgents.map((a) => ({ name: a.name, command: a.command, argsTemplate: a.argsTemplate, promptVia: (a.promptVia ?? 'arg') as 'arg' | 'stdin', label: a.name, detected: false })),
      ];

      // Show selection
      console.log(`\n  ${bold('Which agents should Alfred use?')} ${dim('(comma-separated, e.g. 1,2)')}`);
      const alreadyEnabled = new Set((existing.config.codeAgents?.agents ?? []).map((a) => a.name));
      for (let i = 0; i < allCandidates.length; i++) {
        const c = allCandidates[i];
        const current = alreadyEnabled.has(c.name) ? ` ${dim('(current)')}` : '';
        console.log(`  ${YELLOW}${i + 1}${RESET}) ${c.label}${current}`);
      }
      console.log(`  ${YELLOW}0${RESET}) None`);

      const defaultNums = allCandidates
        .map((c, i) => alreadyEnabled.size > 0 ? (alreadyEnabled.has(c.name) ? String(i + 1) : null) : (c.detected ? String(i + 1) : null))
        .filter(Boolean)
        .join(',') || '0';

      const agentChoice = (
        await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${defaultNums}] `)}`)
      ).trim() || defaultNums;

      if (agentChoice !== '0') {
        const nums = agentChoice.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= allCandidates.length);
        selectedAgents = nums.map((n) => {
          const c = allCandidates[n - 1];
          return { name: c.name, command: c.command, argsTemplate: c.argsTemplate, promptVia: c.promptVia };
        });
      }

      if (selectedAgents.length > 0) {
        console.log(`  ${green('>')} ${bold(String(selectedAgents.length))} agent(s) selected: ${selectedAgents.map((a) => a.name).join(', ')}`);
      } else {
        console.log(`  ${dim('No agents selected.')}`);
      }
    }

    // ── 8d. Forge Integration (GitHub / GitLab) ───────────────
    const existingForge = existing.config.codeAgents?.forge;
    const existingForgeProvider = existingForge?.provider ?? existing.env['ALFRED_FORGE_PROVIDER'] ?? '';
    console.log(`\n${bold('Forge Integration (auto-create PRs/MRs after code agent orchestration)?')}`);
    console.log(`${dim('Connects to GitHub or GitLab to push branches and create pull/merge requests.')}`);
    console.log(`${dim('Owner/repo are detected automatically from the git remote at runtime.')}`);
    const forgeOptions = [
      { num: '1', name: '', label: 'None — skip forge integration' },
      { num: '2', name: 'github', label: 'GitHub' },
      { num: '3', name: 'gitlab', label: 'GitLab' },
    ];
    for (const o of forgeOptions) {
      const current = o.name === existingForgeProvider ? ` ${dim('(current)')}` : '';
      console.log(`  ${YELLOW}${o.num}${RESET}) ${o.label}${current}`);
    }
    const defaultForgeNum = existingForgeProvider === 'github' ? '2' : existingForgeProvider === 'gitlab' ? '3' : '1';
    const forgeChoice = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${defaultForgeNum}] `)}`)
    ).trim() || defaultForgeNum;
    const forgeProvider = forgeOptions.find((o) => o.num === forgeChoice)?.name ?? '';

    let forgeGithubToken = '';
    let forgeGitlabToken = '';

    if (forgeProvider === 'github') {
      console.log(`  ${green('>')} Forge: ${bold('GitHub')}`);
      const existingToken = existing.env['ALFRED_GITHUB_TOKEN'] ?? existingForge?.github?.token ?? '';
      if (existingToken) {
        console.log(`  ${dim(`Current token: ${maskKey(existingToken)}`)}`);
      }
      console.log(`  ${dim('Create a token at https://github.com/settings/tokens (scope: repo)')}`);
      forgeGithubToken = (await rl.question(`  ${BOLD}GitHub Token${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      if (!forgeGithubToken && existingToken) forgeGithubToken = existingToken;
    } else if (forgeProvider === 'gitlab') {
      console.log(`  ${green('>')} Forge: ${bold('GitLab')}`);
      const existingToken = existing.env['ALFRED_GITLAB_TOKEN'] ?? existingForge?.gitlab?.token ?? '';
      if (existingToken) {
        console.log(`  ${dim(`Current token: ${maskKey(existingToken)}`)}`);
      }
      console.log(`  ${dim('Create a token at https://gitlab.com/-/user_settings/personal_access_tokens (scope: api)')}`);
      forgeGitlabToken = (await rl.question(`  ${BOLD}GitLab Token${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      if (!forgeGitlabToken && existingToken) forgeGitlabToken = existingToken;
    } else {
      console.log(`  ${dim('Forge integration disabled — you can enable it later in config/default.yml.')}`);
    }

    // ── 8d2. Web Chat UI ───────────────────────────────────────
    const webUiDefault = existing.webUiEnabled !== false ? 'Y/n' : 'y/N';
    console.log(`\n${bold('Web Chat UI (browser-based chat interface)?')}`);
    console.log(`${dim('Serves a web UI at http://host:port/alfred/ — chat, dashboard, skill health.')}`);
    const webUiAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${webUiDefault}] `)}`)
    ).trim().toLowerCase();
    const enableWebUi = webUiAnswer === '' ? (existing.webUiEnabled !== false) : (webUiAnswer === 'y' || webUiAnswer === 'yes');
    if (enableWebUi) {
      console.log(`  ${green('>')} Web Chat UI ${bold('enabled')} — accessible at /alfred/`);
    } else {
      console.log(`  ${dim('Web Chat UI disabled.')}`);
    }

    // ── 8d3. API Host + TLS + Token ────────────────────────
    let apiHost = '127.0.0.1';
    let enableTls = false;
    let apiToken = '';

    const hostAnswer = (
      await rl.question(`\n${bold('API von anderen Geräten erreichbar machen?')}\n${dim('Setzt host auf 0.0.0.0 statt localhost.')}\n${YELLOW}> ${RESET}${dim('[y/N] ')}`)
    ).trim().toLowerCase();
    if (hostAnswer === 'y' || hostAnswer === 'yes') {
      apiHost = '0.0.0.0';
      console.log(`  ${green('>')} API Host: ${bold('0.0.0.0')} (alle Interfaces)`);

      // TLS recommended for remote access
      console.log(`\n${bold('TLS/HTTPS aktivieren?')}`);
      console.log(`${dim('Empfohlen bei Remote-Zugriff. Selbstsigniertes Zertifikat wird automatisch generiert.')}`);
      const tlsAnswer = (
        await rl.question(`${YELLOW}> ${RESET}${dim('[Y/n] ')}`)
      ).trim().toLowerCase();
      enableTls = tlsAnswer === '' || tlsAnswer === 'y' || tlsAnswer === 'yes';
      if (enableTls) {
        console.log(`  ${green('>')} TLS ${bold('enabled')}`);
      } else {
        console.log(`  ${dim('TLS disabled — API läuft über HTTP.')}`);
      }

      // API Token recommended for remote access
      console.log(`\n${bold('API Token setzen?')}`);
      console.log(`${dim('Schützt die API mit Bearer-Token-Authentifizierung.')}`);
      apiToken = (
        await rl.question(`  ${BOLD}API Token${RESET} ${dim('[Enter to skip]')}: ${YELLOW}`)
      ).trim();
      process.stdout.write(RESET);
      if (apiToken) {
        console.log(`  ${green('>')} API Token gesetzt`);
      }
    } else {
      console.log(`  ${dim('API nur auf localhost erreichbar.')}`);
    }

    // ── 8d4. Cluster ──────────────────────────────────────────
    const existingCluster = (existing.config as any).cluster as ExistingConfig['cluster'] | undefined;
    let clusterEnabled = existingCluster?.enabled ?? false;
    let clusterNodeId = existingCluster?.nodeId ?? '';
    let clusterRole: 'primary' | 'secondary' = (existingCluster?.role as 'primary' | 'secondary') ?? 'primary';
    let clusterRedisUrl = existingCluster?.redisUrl ?? '';
    let clusterToken = existingCluster?.token ?? '';

    console.log(`\n${bold('Cluster / Hochverfügbarkeit?')}`);
    console.log(`${dim('Mehrere Alfred-Nodes für Failover und Last-Verteilung.')}`);
    const clusterDefault = clusterEnabled ? 'Y/n' : 'y/N';
    const clusterAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${clusterDefault}] `)}`)
    ).trim().toLowerCase();
    clusterEnabled = clusterAnswer === '' ? clusterEnabled : (clusterAnswer === 'y' || clusterAnswer === 'yes');

    if (clusterEnabled) {
      const redisDefault = clusterRedisUrl || 'redis://localhost:6379';
      clusterRedisUrl = (await rl.question(`\n  ${BOLD}Redis URL${RESET} ${dim(`[${redisDefault}]`)}: ${YELLOW}`)).trim() || redisDefault;
      process.stdout.write(RESET);

      if (clusterToken) {
        const keepToken = (await rl.question(`  ${BOLD}Cluster-Token${RESET} ${dim(`[bestehend beibehalten: Enter]`)}: ${YELLOW}`)).trim();
        process.stdout.write(RESET);
        if (keepToken) clusterToken = keepToken;
      } else {
        clusterToken = `alf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        console.log(`  ${green('>')} Cluster-Token: ${bold(clusterToken)}`);
        console.log(`  ${dim('  Diesen Token auf allen Nodes identisch setzen.')}`);
      }

      if (!clusterNodeId) {
        clusterNodeId = `node-${Math.random().toString(36).slice(2, 8)}`;
      }
      console.log(`  ${green('>')} Node-ID: ${bold(clusterNodeId)}`);
      // Active-Active: no primary/secondary distinction
      clusterRole = 'primary';
    } else {
      console.log(`  ${dim('Einzelinstanz — kein Cluster.')}`);
    }

    // ── 8d5. Storage Backend (SQLite / PostgreSQL) ──────────
    let storageBackend: 'sqlite' | 'postgres' = 'sqlite';
    let storageConnectionString = '';
    const existingBackend = existing.config.storage?.backend ?? 'sqlite';
    const existingConnStr = existing.env['ALFRED_STORAGE_CONNECTION_STRING'] ?? (existing.config.storage as any)?.connectionString ?? '';

    if (clusterEnabled || existingBackend === 'postgres') {
      console.log(`\n${bold('Datenbank-Backend')}`);
      console.log(`${dim('SQLite ist Standard. PostgreSQL empfohlen für Cluster/HA (gemeinsamer Zustand).')}`);
      console.log(`  ${cyan('1)')} SQLite (lokal, Standard)`);
      console.log(`  ${cyan('2)')} PostgreSQL (HA, gemeinsame DB)`);
      const backendDefault = existingBackend === 'postgres' ? '2' : (clusterEnabled ? '2' : '1');
      const backendChoice = (await rl.question(`${YELLOW}> ${RESET}${dim(`[${backendDefault}] `)}`)).trim() || backendDefault;

      if (backendChoice === '2') {
        storageBackend = 'postgres';
        const connDefault = existingConnStr || 'postgres://alfred:password@localhost:5432/alfred';
        storageConnectionString = await askWithDefault(rl, '  PostgreSQL Connection-String', connDefault);
        console.log(`  ${green('>')} PostgreSQL: ${dim(storageConnectionString.replace(/:[^:@]+@/, ':***@'))}`);

        if (existingBackend === 'sqlite' && existingConnStr !== storageConnectionString) {
          console.log(`  ${yellow('i')} Bestehende SQLite-Daten migrieren: ${bold('alfred migrate-db')}`);
        }
      } else {
        console.log(`  ${green('>')} SQLite (Standard)`);
      }
    }

    // ── 8d6. File Store (Local / NFS / S3) ──────────────────
    let fileStoreBackend: 'local' | 'nfs' | 's3' = 'local';
    let fileStoreBasePath = '';
    let fileStoreS3Endpoint = '';
    let fileStoreS3Bucket = '';
    let fileStoreS3AccessKey = '';
    let fileStoreS3SecretKey = '';
    const existingFileStore = existing.config.fileStore;

    if (clusterEnabled || existingFileStore) {
      console.log(`\n${bold('Datei-Storage')}`);
      console.log(`${dim('Wo sollen Datei-Uploads (Dokumente, Inbox) gespeichert werden?')}`);
      console.log(`  ${cyan('1)')} Lokal (Standard — ./data/files)`);
      console.log(`  ${cyan('2)')} NFS / Netzwerk-Pfad`);
      console.log(`  ${cyan('3)')} S3 / MinIO`);
      const fsDefault = existingFileStore?.backend === 's3' ? '3' : (existingFileStore?.backend === 'nfs' ? '2' : '1');
      const fsChoice = (await rl.question(`${YELLOW}> ${RESET}${dim(`[${fsDefault}] `)}`)).trim() || fsDefault;

      if (fsChoice === '3') {
        fileStoreBackend = 's3';
        fileStoreS3Endpoint = await askWithDefault(rl, '  S3/MinIO Endpoint (z.B. http://minio:9000)', existingFileStore?.s3Endpoint ?? '');
        fileStoreS3Bucket = await askWithDefault(rl, '  Bucket-Name', existingFileStore?.s3Bucket ?? 'alfred-files');
        fileStoreS3AccessKey = await askWithDefault(rl, '  Access Key', existing.env['ALFRED_S3_ACCESS_KEY'] ?? existingFileStore?.s3AccessKey ?? '');
        fileStoreS3SecretKey = await askWithDefault(rl, '  Secret Key', existing.env['ALFRED_S3_SECRET_KEY'] ?? existingFileStore?.s3SecretKey ?? '');
        console.log(`  ${green('>')} S3: ${dim(fileStoreS3Endpoint)} / ${fileStoreS3Bucket}`);
      } else if (fsChoice === '2') {
        fileStoreBackend = 'nfs';
        fileStoreBasePath = await askWithDefault(rl, '  NFS-Pfad', existingFileStore?.basePath ?? '/mnt/alfred-files');
        console.log(`  ${green('>')} NFS: ${dim(fileStoreBasePath)}`);
      } else {
        console.log(`  ${green('>')} Lokal (./data/files)`);
      }
    }

    // ── 8e. Infrastructure (Proxmox / UniFi / Home Assistant) ──
    console.log(`\n${bold('Infrastructure Management (Proxmox / UniFi / Home Assistant)?')}`);
    console.log(`${dim('Control VMs, containers, network devices, and smart home through Alfred.')}`);

    // Proxmox
    const existingPve = existing.config.proxmox;
    const existingPveUrl = existing.env['ALFRED_PROXMOX_BASE_URL'] ?? existingPve?.baseUrl ?? '';
    const enableProxmoxDefault = existingPveUrl ? 'Y/n' : 'y/N';
    const enableProxmoxInput = (
      await rl.question(`  ${BOLD}Enable Proxmox VE?${RESET} ${dim(`[${enableProxmoxDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingPveUrl ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableProxmox = enableProxmoxInput === 'y' || enableProxmoxInput === 'yes';

    let proxmoxBaseUrl = '';
    let proxmoxTokenId = '';
    let proxmoxTokenSecret = '';
    let proxmoxVerifyTls = true;

    if (enableProxmox) {
      proxmoxBaseUrl = await askWithDefault(rl, '  Proxmox URL (e.g. https://pve.local:8006)', existingPveUrl || 'https://pve.local:8006');
      const existingTokenId = existing.env['ALFRED_PROXMOX_TOKEN_ID'] ?? existingPve?.tokenId ?? '';
      if (existingTokenId) console.log(`  ${dim(`Current token ID: ${existingTokenId}`)}`);
      console.log(`  ${dim('Create: Datacenter → Permissions → API Tokens')}`);
      proxmoxTokenId = await askWithDefault(rl, '  API Token ID (user@realm!name)', existingTokenId);
      const existingSecret = existing.env['ALFRED_PROXMOX_TOKEN_SECRET'] ?? existingPve?.tokenSecret ?? '';
      if (existingSecret) console.log(`  ${dim(`Current secret: ${maskKey(existingSecret)}`)}`);
      proxmoxTokenSecret = (await rl.question(`  ${BOLD}API Token Secret${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      if (!proxmoxTokenSecret && existingSecret) proxmoxTokenSecret = existingSecret;
      const tlsDefault = existingPve?.verifyTls === false ? 'y/N' : 'Y/n';
      const tlsInput = (
        await rl.question(`  ${BOLD}Verify TLS?${RESET} ${dim(`(self-signed? → no) [${tlsDefault}]`)}: ${YELLOW}`)
      ).trim().toLowerCase() || (existingPve?.verifyTls === false ? 'n' : 'y');
      process.stdout.write(RESET);
      proxmoxVerifyTls = tlsInput === 'y' || tlsInput === 'yes';
      console.log(`  ${green('>')} Proxmox: ${bold(proxmoxBaseUrl)} ${dim(`(TLS verify: ${proxmoxVerifyTls ? 'yes' : 'no'})`)}`);
    } else {
      console.log(`  ${dim('Proxmox disabled.')}`);
    }

    // Proxmox Backup Server
    const existingPbs = existing.config.proxmoxBackup;
    const existingPbsUrl = existing.env['ALFRED_PBS_BASE_URL'] ?? existingPbs?.baseUrl ?? '';
    const enablePbsDefault = existingPbsUrl ? 'Y/n' : 'y/N';
    const enablePbsInput = (
      await rl.question(`\n  ${BOLD}Enable Proxmox Backup Server?${RESET} ${dim(`[${enablePbsDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingPbsUrl ? 'y' : 'n');
    process.stdout.write(RESET);
    const enablePbs = enablePbsInput === 'y' || enablePbsInput === 'yes';

    let pbsBaseUrl = '';
    let pbsTokenId = '';
    let pbsTokenSecret = '';
    let pbsMaxAgeHours = 24;
    let pbsVerifyTls = true;

    if (enablePbs) {
      pbsBaseUrl = await askWithDefault(rl, '  PBS URL (e.g. https://pbs.local:8007)', existingPbsUrl || 'https://pbs.local:8007');
      const existingPbsTokenId = existing.env['ALFRED_PBS_TOKEN_ID'] ?? existingPbs?.tokenId ?? '';
      if (existingPbsTokenId) console.log(`  ${dim(`Current token ID: ${existingPbsTokenId}`)}`);
      console.log(`  ${dim('Create: Configuration → Access Control → API Token')}`);
      pbsTokenId = await askWithDefault(rl, '  API Token ID (user@realm!name)', existingPbsTokenId);
      const existingPbsSecret = existing.env['ALFRED_PBS_TOKEN_SECRET'] ?? existingPbs?.tokenSecret ?? '';
      if (existingPbsSecret) console.log(`  ${dim(`Current secret: ${maskKey(existingPbsSecret)}`)}`);
      pbsTokenSecret = (await rl.question(`  ${BOLD}API Token Secret${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      if (!pbsTokenSecret && existingPbsSecret) pbsTokenSecret = existingPbsSecret;
      const existingMaxAge = existing.env['ALFRED_PBS_MAX_AGE_HOURS'] ?? existingPbs?.maxAgeHours?.toString() ?? '24';
      pbsMaxAgeHours = parseInt(await askWithDefault(rl, '  Max backup age (hours, alert if older)', existingMaxAge), 10) || 24;
      const pbsTlsDefault = existingPbs?.verifyTls === false ? 'y/N' : 'Y/n';
      const pbsTlsInput = (
        await rl.question(`  ${BOLD}Verify TLS?${RESET} ${dim(`(self-signed? → no) [${pbsTlsDefault}]`)}: ${YELLOW}`)
      ).trim().toLowerCase() || (existingPbs?.verifyTls === false ? 'n' : 'y');
      process.stdout.write(RESET);
      pbsVerifyTls = pbsTlsInput === 'y' || pbsTlsInput === 'yes';
      console.log(`  ${green('>')} PBS: ${bold(pbsBaseUrl)} ${dim(`(max age: ${pbsMaxAgeHours}h, TLS verify: ${pbsVerifyTls ? 'yes' : 'no'})`)}`);
    } else {
      console.log(`  ${dim('Proxmox Backup Server disabled.')}`);
    }

    // UniFi
    const existingUnifi = existing.config.unifi;
    const existingUnifiUrl = existing.env['ALFRED_UNIFI_BASE_URL'] ?? existingUnifi?.baseUrl ?? '';
    const enableUnifiDefault = existingUnifiUrl ? 'Y/n' : 'y/N';
    const enableUnifiInput = (
      await rl.question(`\n  ${BOLD}Enable UniFi Network?${RESET} ${dim(`[${enableUnifiDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingUnifiUrl ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableUnifi = enableUnifiInput === 'y' || enableUnifiInput === 'yes';

    let unifiBaseUrl = '';
    let unifiApiKey = '';
    let unifiUsername = '';
    let unifiPassword = '';
    let unifiVerifyTls = true;

    if (enableUnifi) {
      unifiBaseUrl = await askWithDefault(rl, '  UniFi URL (e.g. https://unifi.local)', existingUnifiUrl || 'https://unifi.local');
      console.log(`  ${dim('Auth: API Key (recommended) or Username/Password')}`);
      const existingApiKey = existing.env['ALFRED_UNIFI_API_KEY'] ?? existingUnifi?.apiKey ?? '';
      const authOptions = [
        { num: '1', name: 'apikey', label: 'API Key (UniFi OS)' },
        { num: '2', name: 'password', label: 'Username / Password' },
      ];
      const defaultAuthNum = existingApiKey ? '1' : (existingUnifi?.username ? '2' : '1');
      for (const o of authOptions) console.log(`    ${YELLOW}${o.num}${RESET}) ${o.label}`);
      const authChoice = (
        await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${defaultAuthNum}] `)}`)
      ).trim() || defaultAuthNum;

      if (authChoice === '1') {
        if (existingApiKey) console.log(`  ${dim(`Current key: ${maskKey(existingApiKey)}`)}`);
        console.log(`  ${dim('Create: Settings → Admins → API Keys (UniFi OS)')}`);
        unifiApiKey = (await rl.question(`  ${BOLD}API Key${RESET}: ${YELLOW}`)).trim();
        process.stdout.write(RESET);
        if (!unifiApiKey && existingApiKey) unifiApiKey = existingApiKey;
      } else {
        const existingUser = existing.env['ALFRED_UNIFI_USERNAME'] ?? existingUnifi?.username ?? '';
        unifiUsername = await askWithDefault(rl, '  Username', existingUser || 'alfred');
        const existingPass = existing.env['ALFRED_UNIFI_PASSWORD'] ?? existingUnifi?.password ?? '';
        if (existingPass) console.log(`  ${dim(`Current password: ${maskKey(existingPass)}`)}`);
        unifiPassword = (await rl.question(`  ${BOLD}Password${RESET}: ${YELLOW}`)).trim();
        process.stdout.write(RESET);
        if (!unifiPassword && existingPass) unifiPassword = existingPass;
      }

      const unifiTlsDefault = existingUnifi?.verifyTls === false ? 'y/N' : 'Y/n';
      const unifiTlsInput = (
        await rl.question(`  ${BOLD}Verify TLS?${RESET} ${dim(`(self-signed? → no) [${unifiTlsDefault}]`)}: ${YELLOW}`)
      ).trim().toLowerCase() || (existingUnifi?.verifyTls === false ? 'n' : 'y');
      process.stdout.write(RESET);
      unifiVerifyTls = unifiTlsInput === 'y' || unifiTlsInput === 'yes';
      console.log(`  ${green('>')} UniFi: ${bold(unifiBaseUrl)} ${dim(`(TLS verify: ${unifiVerifyTls ? 'yes' : 'no'})`)}`);
    } else {
      console.log(`  ${dim('UniFi disabled.')}`);
    }

    // Home Assistant
    const existingHa = existing.config.homeassistant;
    const existingHaUrl = existing.env['ALFRED_HOMEASSISTANT_URL'] ?? existingHa?.baseUrl ?? '';
    const enableHaDefault = existingHaUrl ? 'Y/n' : 'y/N';
    const enableHaInput = (
      await rl.question(`\n  ${BOLD}Enable Home Assistant?${RESET} ${dim(`[${enableHaDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingHaUrl ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableHa = enableHaInput === 'y' || enableHaInput === 'yes';

    let haBaseUrl = '';
    let haAccessToken = '';
    let haVerifyTls = true;

    if (enableHa) {
      haBaseUrl = await askWithDefault(rl, '  Home Assistant URL (e.g. http://homeassistant.local:8123)', existingHaUrl || 'http://homeassistant.local:8123');
      const existingToken = existing.env['ALFRED_HOMEASSISTANT_TOKEN'] ?? existingHa?.accessToken ?? '';
      if (existingToken) console.log(`  ${dim(`Current token: ${maskKey(existingToken)}`)}`);
      console.log(`  ${dim('Create: Settings → Security → Long-Lived Access Tokens')}`);
      haAccessToken = (await rl.question(`  ${BOLD}Long-Lived Access Token${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      if (!haAccessToken && existingToken) haAccessToken = existingToken;
      const haTlsDefault = existingHa?.verifyTls === false ? 'y/N' : 'Y/n';
      const haTlsInput = (
        await rl.question(`  ${BOLD}Verify TLS?${RESET} ${dim(`(self-signed? → no) [${haTlsDefault}]`)}: ${YELLOW}`)
      ).trim().toLowerCase() || (existingHa?.verifyTls === false ? 'n' : 'y');
      process.stdout.write(RESET);
      haVerifyTls = haTlsInput === 'y' || haTlsInput === 'yes';
      console.log(`  ${green('>')} Home Assistant: ${bold(haBaseUrl)} ${dim(`(TLS verify: ${haVerifyTls ? 'yes' : 'no'})`)}`);
    } else {
      console.log(`  ${dim('Home Assistant disabled.')}`);
    }

    // Contacts
    const existingContacts = existing.config.contacts;
    const existingContactsProvider = existing.env['ALFRED_CONTACTS_PROVIDER'] ?? existingContacts?.provider ?? '';
    const enableContactsDefault = existingContactsProvider ? 'Y/n' : 'y/N';
    const enableContactsInput = (
      await rl.question(`\n  ${BOLD}Enable Contacts management?${RESET} ${dim(`[${enableContactsDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingContactsProvider ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableContacts = enableContactsInput === 'y' || enableContactsInput === 'yes';

    let contactsProvider = '';
    let contactsEnvEntries: Record<string, string> = {};

    if (enableContacts) {
      const contactsProviders = ['carddav', 'google', 'microsoft'] as const;
      const existingIdx = contactsProviders.indexOf(existingContactsProvider as typeof contactsProviders[number]);
      const defaultChoice = existingIdx >= 0 ? existingIdx + 1 : 1;
      console.log(`    ${cyan('1)')} CardDAV (Nextcloud, Radicale, etc.)`);
      console.log(`    ${cyan('2)')} Google Contacts`);
      console.log(`    ${cyan('3)')} Microsoft 365`);
      const contactsChoice = await askNumber(rl, '  > ', 1, 3, defaultChoice);
      contactsProvider = contactsProviders[contactsChoice - 1];
      contactsEnvEntries['ALFRED_CONTACTS_PROVIDER'] = contactsProvider;

      if (contactsProvider === 'carddav') {
        const existingUrl = existing.env['ALFRED_CARDDAV_CONTACTS_SERVER_URL'] ?? existingContacts?.carddav?.serverUrl ?? '';
        contactsEnvEntries['ALFRED_CARDDAV_CONTACTS_SERVER_URL'] = await askWithDefault(rl, '  CardDAV Server URL', existingUrl || 'https://cloud.example.com/remote.php/dav');
        const existingUser = existing.env['ALFRED_CARDDAV_CONTACTS_USERNAME'] ?? existingContacts?.carddav?.username ?? '';
        contactsEnvEntries['ALFRED_CARDDAV_CONTACTS_USERNAME'] = await askWithDefault(rl, '  Username', existingUser);
        const existingPass = existing.env['ALFRED_CARDDAV_CONTACTS_PASSWORD'] ?? existingContacts?.carddav?.password ?? '';
        if (existingPass) console.log(`  ${dim(`Current password: ${maskKey(existingPass)}`)}`);
        const pass = (await rl.question(`  ${BOLD}Password${RESET}: ${YELLOW}`)).trim();
        process.stdout.write(RESET);
        contactsEnvEntries['ALFRED_CARDDAV_CONTACTS_PASSWORD'] = pass || existingPass;
      } else if (contactsProvider === 'google') {
        const existingClientId = existing.env['ALFRED_GOOGLE_CONTACTS_CLIENT_ID'] ?? existingContacts?.google?.clientId ?? '';
        if (existingClientId) console.log(`  ${dim(`Current client ID: ${maskKey(existingClientId)}`)}`);
        contactsEnvEntries['ALFRED_GOOGLE_CONTACTS_CLIENT_ID'] = (await rl.question(`  ${BOLD}Google Client ID${RESET}: ${YELLOW}`)).trim() || existingClientId;
        process.stdout.write(RESET);
        const existingSecret = existing.env['ALFRED_GOOGLE_CONTACTS_CLIENT_SECRET'] ?? existingContacts?.google?.clientSecret ?? '';
        contactsEnvEntries['ALFRED_GOOGLE_CONTACTS_CLIENT_SECRET'] = (await rl.question(`  ${BOLD}Google Client Secret${RESET}: ${YELLOW}`)).trim() || existingSecret;
        process.stdout.write(RESET);
        const existingRefresh = existing.env['ALFRED_GOOGLE_CONTACTS_REFRESH_TOKEN'] ?? existingContacts?.google?.refreshToken ?? '';
        contactsEnvEntries['ALFRED_GOOGLE_CONTACTS_REFRESH_TOKEN'] = (await rl.question(`  ${BOLD}Refresh Token${RESET}: ${YELLOW}`)).trim() || existingRefresh;
        process.stdout.write(RESET);
      } else if (contactsProvider === 'microsoft') {
        const existingClientId = existing.env['ALFRED_MICROSOFT_CONTACTS_CLIENT_ID'] ?? existingContacts?.microsoft?.clientId ?? '';
        if (existingClientId) console.log(`  ${dim(`Current client ID: ${maskKey(existingClientId)}`)}`);
        contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_CLIENT_ID'] = (await rl.question(`  ${BOLD}Microsoft Client ID${RESET}: ${YELLOW}`)).trim() || existingClientId;
        process.stdout.write(RESET);
        const existingSecret = existing.env['ALFRED_MICROSOFT_CONTACTS_CLIENT_SECRET'] ?? existingContacts?.microsoft?.clientSecret ?? '';
        contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_CLIENT_SECRET'] = (await rl.question(`  ${BOLD}Microsoft Client Secret${RESET}: ${YELLOW}`)).trim() || existingSecret;
        process.stdout.write(RESET);
        const existingTenantId = existing.env['ALFRED_MICROSOFT_CONTACTS_TENANT_ID'] ?? existingContacts?.microsoft?.tenantId ?? '';
        contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_TENANT_ID'] = await askWithDefault(rl, '  Tenant ID', existingTenantId || 'common');
        const existingRefresh = existing.env['ALFRED_MICROSOFT_CONTACTS_REFRESH_TOKEN'] ?? existingContacts?.microsoft?.refreshToken ?? '';
        console.log(`  ${dim('Tipp: Du kannst `alfred auth microsoft` ausführen um den Refresh Token automatisch zu holen.')}`);
        contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_REFRESH_TOKEN'] = (await rl.question(`  ${BOLD}Refresh Token${RESET}: ${YELLOW}`)).trim() || existingRefresh;
        process.stdout.write(RESET);
      }
      console.log(`  ${green('>')} Contacts: ${bold(contactsProvider)}`);
    } else {
      console.log(`  ${dim('Contacts disabled.')}`);
    }

    // Docker
    const existingDocker = existing.config.docker;
    const existingDockerSocket = existing.env['ALFRED_DOCKER_SOCKET_PATH'] ?? existingDocker?.socketPath ?? '';
    const existingDockerHost = existing.env['ALFRED_DOCKER_HOST'] ?? existingDocker?.host ?? '';
    const enableDockerDefault = (existingDockerSocket || existingDockerHost) ? 'Y/n' : 'y/N';
    const enableDockerInput = (
      await rl.question(`\n  ${BOLD}Enable Docker management?${RESET} ${dim(`[${enableDockerDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || ((existingDockerSocket || existingDockerHost) ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableDocker = enableDockerInput === 'y' || enableDockerInput === 'yes';

    let dockerSocketPath = '';
    let dockerHost = '';

    if (enableDocker) {
      const defaultSocket = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
      console.log(`  ${dim('Use socket path for local Docker, or host URL for remote.')}`);
      dockerSocketPath = await askWithDefault(rl, '  Docker socket path', existingDockerSocket || defaultSocket);
      const hostInput = (await rl.question(`  ${BOLD}Docker host URL (optional, for remote)${RESET}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      dockerHost = hostInput || existingDockerHost;
      console.log(`  ${green('>')} Docker: ${bold(dockerHost || dockerSocketPath)}`);
    } else {
      console.log(`  ${dim('Docker disabled.')}`);
    }

    // Bitpanda
    const existingBitpandaKey = existing.env['ALFRED_BITPANDA_API_KEY'] ?? (existing.config as any).bitpanda?.apiKey ?? '';
    const enableBitpandaDefault = existingBitpandaKey ? 'Y/n' : 'y/N';
    const enableBitpandaInput = (
      await rl.question(`\n  ${BOLD}Enable Bitpanda (Portfolio, Crypto/Aktien/ETF Preise)?${RESET} ${dim(`[${enableBitpandaDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingBitpandaKey ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableBitpanda = enableBitpandaInput === 'y' || enableBitpandaInput === 'yes';

    let bitpandaApiKey = '';

    if (enableBitpanda) {
      console.log(`  ${dim('API Key erstellen: Bitpanda App → Einstellungen → API Key')}`);
      console.log(`  ${dim('Berechtigungen: "Read" für Portfolio, "Trade" für Kauf/Verkauf')}`);
      bitpandaApiKey = await askWithDefault(rl, '  Bitpanda API Key', existingBitpandaKey);
      console.log(`  ${green('>')} Bitpanda: ${bold('enabled')}`);
    } else {
      console.log(`  ${dim('Bitpanda disabled. Ticker/Preise funktionieren trotzdem ohne API Key.')}`);
    }

    // Trading (CCXT)
    const existingTradingExchanges = existing.env['ALFRED_TRADING_EXCHANGES'] ?? '';
    const enableTradingDefault = existingTradingExchanges ? 'Y/n' : 'y/N';
    const enableTradingInput = (
      await rl.question(`\n  ${BOLD}Enable Crypto Trading (Binance, Kraken, Coinbase etc.)?${RESET} ${dim(`[${enableTradingDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingTradingExchanges ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableTrading = enableTradingInput === 'y' || enableTradingInput === 'yes';

    const tradingExchanges: Array<{ name: string; apiKey: string; secret: string }> = [];

    if (enableTrading) {
      console.log(`  ${dim('Welche Exchanges? (Komma-getrennt, z.B. binance,kraken)')}`);
      const exchangeList = (await rl.question(`  ${BOLD}Exchanges${RESET} ${dim(`[${existingTradingExchanges || 'binance'}]`)}: ${YELLOW}`)).trim() || existingTradingExchanges || 'binance';
      process.stdout.write(RESET);
      const exchangeNames = exchangeList.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);

      for (const ex of exchangeNames) {
        const upper = ex.toUpperCase();
        const existingKey = existing.env[`ALFRED_TRADING_${upper}_API_KEY`] ?? '';
        const existingSecret = existing.env[`ALFRED_TRADING_${upper}_SECRET`] ?? '';
        const apiKey = await askWithDefault(rl, `  ${ex} API Key`, existingKey);
        const secret = await askWithDefault(rl, `  ${ex} Secret`, existingSecret);
        if (apiKey && secret) {
          tradingExchanges.push({ name: ex, apiKey, secret });
        }
      }

      if (tradingExchanges.length > 0) {
        console.log(`  ${green('>')} Trading: ${bold(tradingExchanges.map(e => e.name).join(', '))}`);
      } else {
        console.log(`  ${dim('Keine Exchange-Credentials eingegeben.')}`);
      }
    } else {
      console.log(`  ${dim('Trading disabled.')}`);
    }

    // BMW CarData
    const existingBmw = existing.config.bmw;
    const existingBmwClientId = existing.env['ALFRED_BMW_CLIENT_ID'] ?? existingBmw?.clientId ?? '';
    const enableBmwDefault = existingBmwClientId ? 'Y/n' : 'y/N';
    const enableBmwInput = (
      await rl.question(`\n  ${BOLD}Enable BMW CarData (vehicle status, charging)?${RESET} ${dim(`[${enableBmwDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingBmwClientId ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableBmw = enableBmwInput === 'y' || enableBmwInput === 'yes';

    let bmwClientId = '';

    if (enableBmw) {
      console.log(`  ${dim('Setup:')}`);
      console.log(`  ${dim('  1. Öffne https://bmw-cardata.bmwgroup.com/customer')}`);
      console.log(`  ${dim('  2. Login mit deinem MyBMW-Account')}`);
      console.log(`  ${dim('  3. Client-ID generieren')}`);
      console.log(`  ${dim('  4. Scope "CarData API" aktivieren (ca. 60s warten)')}`);
      bmwClientId = await askWithDefault(rl, '  BMW CarData Client ID', existingBmwClientId);
      console.log(`  ${green('>')} BMW CarData: ${bold('enabled')}`);
    } else {
      console.log(`  ${dim('BMW CarData disabled.')}`);
    }

    // Google Routing
    const existingRouting = existing.config.routing;
    const existingRoutingApiKey = existing.env['ALFRED_ROUTING_API_KEY'] ?? existingRouting?.apiKey ?? '';
    const enableRoutingDefault = existingRoutingApiKey ? 'Y/n' : 'y/N';
    const enableRoutingInput = (
      await rl.question(`\n  ${BOLD}Enable route planning with live traffic (Google Routes)?${RESET} ${dim(`[${enableRoutingDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingRoutingApiKey ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableRouting = enableRoutingInput === 'y' || enableRoutingInput === 'yes';

    let routingApiKey = '';

    if (enableRouting) {
      console.log(`  ${dim('Setup:')}`);
      console.log(`  ${dim('  1. Öffne https://console.cloud.google.com')}`);
      console.log(`  ${dim('  2. Routes API aktivieren')}`);
      console.log(`  ${dim('  3. API Key erstellen')}`);
      routingApiKey = await askWithDefault(rl, '  Google Maps API Key', existingRoutingApiKey);
      console.log(`  ${green('>')} Routing: ${bold('enabled')}`);
    } else {
      console.log(`  ${dim('Routing disabled.')}`);
    }

    // YouTube
    const existingYoutube = existing.config.youtube as Record<string, unknown> | undefined;
    const existingYoutubeKey = existing.env['ALFRED_YOUTUBE_API_KEY'] ?? (existingYoutube?.apiKey as string) ?? '';
    const existingSupadataKey = existing.env['ALFRED_SUPADATA_API_KEY'] ?? ((existingYoutube?.supadata as Record<string, unknown>)?.apiKey as string) ?? '';
    const enableYoutubeDefault = existingYoutubeKey ? 'Y/n' : 'y/N';
    const enableYoutubeInput = (
      await rl.question(`\n  ${BOLD}Enable YouTube (search, video info, transcripts)?${RESET} ${dim(`[${enableYoutubeDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingYoutubeKey ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableYoutube = enableYoutubeInput === 'y' || enableYoutubeInput === 'yes';

    let youtubeApiKey = '';
    let supadataApiKey = '';

    if (enableYoutube) {
      console.log(`  ${dim('Setup:')}`);
      console.log(`  ${dim('  1. Öffne https://console.cloud.google.com')}`);
      console.log(`  ${dim('  2. YouTube Data API v3 aktivieren')}`);
      console.log(`  ${dim('  3. API Key erstellen (gleicher Key wie für Routing möglich)')}`);
      youtubeApiKey = await askWithDefault(rl, '  YouTube API Key', existingYoutubeKey);

      const supadataInput = (
        await rl.question(`  ${BOLD}Supadata API Key (optional, Transkript-Fallback)?${RESET} ${dim('[Enter to skip]')}: ${YELLOW}`)
      ).trim();
      process.stdout.write(RESET);
      supadataApiKey = supadataInput || existingSupadataKey;

      console.log(`  ${green('>')} YouTube: ${bold('enabled')}${supadataApiKey ? ' + Supadata Fallback' : ''}`);
    } else {
      console.log(`  ${dim('YouTube disabled.')}`);
    }

    // Energy / aWATTar
    const existingEnergy = existing.config.energy;
    const existingGridName = existing.env['ALFRED_ENERGY_GRID_NAME'] ?? existingEnergy?.gridName ?? '';
    const existingGridUsage = existing.env['ALFRED_ENERGY_GRID_USAGE_CT'] ?? (existingEnergy?.gridUsageCt != null ? String(existingEnergy.gridUsageCt) : '');
    const existingGridLoss = existing.env['ALFRED_ENERGY_GRID_LOSS_CT'] ?? (existingEnergy?.gridLossCt != null ? String(existingEnergy.gridLossCt) : '');
    const existingGridCapacity = existing.env['ALFRED_ENERGY_GRID_CAPACITY_FEE'] ?? (existingEnergy?.gridCapacityFee != null ? String(existingEnergy.gridCapacityFee) : '');
    const existingGridMeter = existing.env['ALFRED_ENERGY_GRID_METER_FEE'] ?? (existingEnergy?.gridMeterFee != null ? String(existingEnergy.gridMeterFee) : '');
    const enableEnergyDefault = existingGridUsage ? 'Y/n' : 'y/N';
    const enableEnergyInput = (
      await rl.question(`\n  ${BOLD}Enable energy prices (aWATTar HOURLY / EPEX Spot AT)?${RESET} ${dim(`[${enableEnergyDefault}]`)}: ${YELLOW}`)
    ).trim().toLowerCase() || (existingGridUsage ? 'y' : 'n');
    process.stdout.write(RESET);
    const enableEnergy = enableEnergyInput === 'y' || enableEnergyInput === 'yes';

    let energyGridName = '';
    let energyGridUsageCt = '';
    let energyGridLossCt = '';
    let energyGridCapacityFee = '';
    let energyGridMeterFee = '';

    if (enableEnergy) {
      console.log(`  ${dim('Die Werte findest du auf deiner Stromrechnung unter "Netzentgelte".')}`);
      console.log(`  ${dim('Marktpreis + aWATTar-Aufschlag + Abgaben werden automatisch berechnet.')}`);
      console.log('');
      energyGridName = await askWithDefault(rl, '  Netzbetreiber Name (z.B. Netz Niederösterreich)', existingGridName);
      energyGridUsageCt = await askWithDefault(rl, '  Netznutzungsentgelt (ct/kWh netto)', existingGridUsage);
      energyGridLossCt = await askWithDefault(rl, '  Netzverlustentgelt (ct/kWh netto)', existingGridLoss || '0.38');
      energyGridCapacityFee = await askWithDefault(rl, '  Leistungspauschale (€/Monat netto)', existingGridCapacity);
      energyGridMeterFee = await askWithDefault(rl, '  Messentgelt (€/Monat netto)', existingGridMeter || '2.22');
      console.log(`  ${green('>')} Energy: ${bold(energyGridName || 'enabled')} (${energyGridUsageCt} + ${energyGridLossCt} ct/kWh)`);
    } else {
      console.log(`  ${dim('Energy prices disabled (Marktpreise weiterhin ohne Netzentgelte verfügbar).')}`);
    }

    // ── 9. Security configuration ──────────────────────────────
    console.log(`\n${bold('Security configuration:')}`);

    // 7a. Owner user ID
    const existingOwnerId = existing.config.security?.ownerUserId ?? existing.env['ALFRED_OWNER_USER_ID'] ?? '';
    let ownerUserId: string;
    if (existingOwnerId) {
      ownerUserId = await askWithDefault(rl, 'Owner user ID (for elevated permissions)', existingOwnerId);
    } else {
      const input = (await rl.question(
        `${BOLD}Owner user ID${RESET} ${dim('(optional, for elevated permissions)')}: ${YELLOW}`,
      )).trim();
      process.stdout.write(RESET);
      ownerUserId = input;
    }

    // 7b. Shell access (only if owner is set)
    let enableShell = false;
    if (ownerUserId) {
      const shellDefault = existing.shellEnabled ? 'Y/n' : 'y/N';
      console.log('');
      console.log(`  ${bold('Enable shell access (admin commands) for the owner?')}`);
      console.log(`  ${dim('Allows Alfred to execute shell commands. Only for the owner.')}`);
      const shellAnswer = (
        await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${shellDefault}] `)}`)
      ).trim().toLowerCase();
      if (shellAnswer === '') {
        enableShell = existing.shellEnabled;
      } else {
        enableShell = shellAnswer === 'y' || shellAnswer === 'yes';
      }
      if (enableShell) {
        console.log(`    ${green('>')} Shell access ${bold('enabled')} for owner ${dim(ownerUserId)}`);
      } else {
        console.log(`    ${dim('Shell access disabled.')}`);
      }
    }

    // 7c. Write access in groups
    const writeGroupsDefault = existing.writeInGroups ? 'Y/n' : 'y/N';
    console.log('');
    console.log(`  ${bold('Allow write actions (notes, reminders, memory) in group chats?')}`);
    console.log(`  ${dim('By default, write actions are only allowed in DMs.')}`);
    const writeGroupsAnswer = (
      await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${writeGroupsDefault}] `)}`)
    ).trim().toLowerCase();
    let writeInGroups: boolean;
    if (writeGroupsAnswer === '') {
      writeInGroups = existing.writeInGroups;
    } else {
      writeInGroups = writeGroupsAnswer === 'y' || writeGroupsAnswer === 'yes';
    }
    if (writeInGroups) {
      console.log(`    ${green('>')} Write actions ${bold('enabled')} in groups`);
    } else {
      console.log(`    ${dim('Write actions only in DMs (default).')}`);
    }

    // 7d. Rate limit
    const existingRateLimit = existing.rateLimit ?? 30;
    console.log('');
    const rateLimitStr = await askWithDefault(rl, '  Rate limit (max write actions per hour per user)', String(existingRateLimit));
    const rateLimit = Math.max(1, parseInt(rateLimitStr, 10) || 30);
    console.log(`    ${green('>')} Rate limit: ${bold(String(rateLimit))} per hour`);


    // ── 9. Generate .env ─────────────────────────────────────────
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
      const envKeyName = provider.envKeyName || 'ALFRED_OLLAMA_API_KEY';
      envLines.push(`${envKeyName}=${apiKey}`);
    }

    if (model !== provider.defaultModel) {
      envLines.push(`ALFRED_LLM_MODEL=${model}`);
    }

    if (baseUrl) {
      envLines.push(`ALFRED_LLM_BASE_URL=${baseUrl}`);
    }

    // Multi-model tier env vars
    if (Object.keys(configuredTiers).length > 0) {
      envLines.push('', '# === Additional Model Tiers ===');
      for (const [tierKey, tierCfg] of Object.entries(configuredTiers)) {
        const prefix = `ALFRED_LLM_${tierKey.toUpperCase()}`;
        envLines.push('');
        envLines.push(`${prefix}_PROVIDER=${tierCfg.provider}`);
        envLines.push(`${prefix}_MODEL=${tierCfg.model}`);
        if (tierCfg.apiKey) {
          envLines.push(`${prefix}_API_KEY=${tierCfg.apiKey}`);
        }
        if (tierCfg.baseUrl) {
          envLines.push(`${prefix}_BASE_URL=${tierCfg.baseUrl}`);
        }
      }
    }

    envLines.push('', '# === Messaging Platforms ===', '');

    for (const [envKey, envVal] of Object.entries(envOverrides)) {
      envLines.push(`${envKey}=${envVal}`);
    }

    envLines.push('', '# === Web Search ===', '');

    if (searchProvider) {
      envLines.push(`ALFRED_SEARCH_PROVIDER=${searchProvider}`);
      if (searchApiKey) {
        envLines.push(`ALFRED_SEARCH_API_KEY=${searchApiKey}`);
      }
      if (searchBaseUrl) {
        envLines.push(`ALFRED_SEARCH_BASE_URL=${searchBaseUrl}`);
      }
    } else {
      envLines.push('# ALFRED_SEARCH_PROVIDER=brave');
      envLines.push('# ALFRED_SEARCH_API_KEY=');
    }

    envLines.push('', '# === Email ===', '');

    if (enableEmail && emailAccounts.length > 0) {
      const firstAcct = emailAccounts[0];
      if (firstAcct.provider === 'microsoft') {
        envLines.push(`ALFRED_EMAIL_PROVIDER=microsoft`);
        if (firstAcct.msClientId) {
          envLines.push(`ALFRED_MICROSOFT_EMAIL_CLIENT_ID=${firstAcct.msClientId}`);
          envLines.push(`ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET=${firstAcct.msClientSecret}`);
          envLines.push(`ALFRED_MICROSOFT_EMAIL_TENANT_ID=${firstAcct.msTenantId}`);
          envLines.push(`ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN=${firstAcct.msRefreshToken}`);
        } else {
          envLines.push('# Microsoft email credentials shared from calendar config');
        }
      } else {
        envLines.push(`ALFRED_EMAIL_USER=${firstAcct.user}`);
        envLines.push(`ALFRED_EMAIL_PASS=${firstAcct.pass}`);
      }
      if (emailAccounts.length > 1) {
        envLines.push('# Additional email accounts configured in config/default.yml');
      }
    } else {
      envLines.push('# ALFRED_EMAIL_USER=');
      envLines.push('# ALFRED_EMAIL_PASS=');
    }

    envLines.push('', '# === Speech ===', '');

    if (speechProvider) {
      envLines.push(`ALFRED_SPEECH_PROVIDER=${speechProvider}`);
      envLines.push(`ALFRED_SPEECH_API_KEY=${speechApiKey}`);
      if (speechBaseUrl) {
        envLines.push(`ALFRED_SPEECH_BASE_URL=${speechBaseUrl}`);
      }
      if (ttsEnabled) {
        envLines.push(`ALFRED_TTS_ENABLED=true`);
        envLines.push(`ALFRED_TTS_VOICE=${ttsVoice}`);
      }
    } else {
      envLines.push('# ALFRED_SPEECH_PROVIDER=groq');
      envLines.push('# ALFRED_SPEECH_API_KEY=');
    }

    envLines.push('', '# === Forge (GitHub / GitLab) ===', '');

    if (forgeProvider === 'github') {
      envLines.push(`ALFRED_FORGE_PROVIDER=github`);
      envLines.push(`ALFRED_GITHUB_TOKEN=${forgeGithubToken}`);
    } else if (forgeProvider === 'gitlab') {
      envLines.push(`ALFRED_FORGE_PROVIDER=gitlab`);
      envLines.push(`ALFRED_GITLAB_TOKEN=${forgeGitlabToken}`);
    } else {
      envLines.push('# ALFRED_FORGE_PROVIDER=github');
      envLines.push('# ALFRED_GITHUB_TOKEN=');
    }

    envLines.push('', '# === Infrastructure (Proxmox / UniFi / Home Assistant) ===', '');

    if (enableProxmox) {
      envLines.push(`ALFRED_PROXMOX_BASE_URL=${proxmoxBaseUrl}`);
      envLines.push(`ALFRED_PROXMOX_TOKEN_ID=${proxmoxTokenId}`);
      envLines.push(`ALFRED_PROXMOX_TOKEN_SECRET=${proxmoxTokenSecret}`);
    } else {
      envLines.push('# ALFRED_PROXMOX_BASE_URL=');
      envLines.push('# ALFRED_PROXMOX_TOKEN_ID=');
      envLines.push('# ALFRED_PROXMOX_TOKEN_SECRET=');
    }

    if (enablePbs) {
      envLines.push(`ALFRED_PBS_BASE_URL=${pbsBaseUrl}`);
      envLines.push(`ALFRED_PBS_TOKEN_ID=${pbsTokenId}`);
      envLines.push(`ALFRED_PBS_TOKEN_SECRET=${pbsTokenSecret}`);
      envLines.push(`ALFRED_PBS_MAX_AGE_HOURS=${pbsMaxAgeHours}`);
      if (!pbsVerifyTls) envLines.push('ALFRED_PBS_VERIFY_TLS=false');
    } else {
      envLines.push('# ALFRED_PBS_BASE_URL=');
      envLines.push('# ALFRED_PBS_TOKEN_ID=');
      envLines.push('# ALFRED_PBS_TOKEN_SECRET=');
    }

    if (enableUnifi && unifiApiKey) {
      envLines.push(`ALFRED_UNIFI_BASE_URL=${unifiBaseUrl}`);
      envLines.push(`ALFRED_UNIFI_API_KEY=${unifiApiKey}`);
    } else if (enableUnifi) {
      envLines.push(`ALFRED_UNIFI_BASE_URL=${unifiBaseUrl}`);
      envLines.push(`ALFRED_UNIFI_USERNAME=${unifiUsername}`);
      envLines.push(`ALFRED_UNIFI_PASSWORD=${unifiPassword}`);
    } else {
      envLines.push('# ALFRED_UNIFI_BASE_URL=');
      envLines.push('# ALFRED_UNIFI_API_KEY=');
    }

    if (enableHa) {
      envLines.push(`ALFRED_HOMEASSISTANT_URL=${haBaseUrl}`);
      envLines.push(`ALFRED_HOMEASSISTANT_TOKEN=${haAccessToken}`);
    } else {
      envLines.push('# ALFRED_HOMEASSISTANT_URL=');
      envLines.push('# ALFRED_HOMEASSISTANT_TOKEN=');
    }

    envLines.push('', '# === Contacts ===', '');

    if (enableContacts) {
      for (const [key, val] of Object.entries(contactsEnvEntries)) {
        envLines.push(`${key}=${val}`);
      }
    } else {
      envLines.push('# ALFRED_CONTACTS_PROVIDER=carddav');
    }

    envLines.push('', '# === Docker ===', '');

    if (enableDocker) {
      if (dockerSocketPath) envLines.push(`ALFRED_DOCKER_SOCKET_PATH=${dockerSocketPath}`);
      if (dockerHost) envLines.push(`ALFRED_DOCKER_HOST=${dockerHost}`);
    } else {
      envLines.push('# ALFRED_DOCKER_SOCKET_PATH=');
      envLines.push('# ALFRED_DOCKER_HOST=');
    }

    envLines.push('', '# === BMW CarData ===', '');

    if (enableBitpanda) {
      envLines.push(`ALFRED_BITPANDA_API_KEY=${bitpandaApiKey}`);
    } else {
      envLines.push('# ALFRED_BITPANDA_API_KEY=');
    }

    if (tradingExchanges.length > 0) {
      envLines.push(`ALFRED_TRADING_EXCHANGES=${tradingExchanges.map(e => e.name).join(',')}`);
      envLines.push(`ALFRED_TRADING_DEFAULT_EXCHANGE=${tradingExchanges[0].name}`);
      envLines.push('ALFRED_TRADING_MAX_ORDER_EUR=500');
      for (const ex of tradingExchanges) {
        const upper = ex.name.toUpperCase();
        envLines.push(`ALFRED_TRADING_${upper}_API_KEY=${ex.apiKey}`);
        envLines.push(`ALFRED_TRADING_${upper}_SECRET=${ex.secret}`);
      }
    } else {
      envLines.push('# ALFRED_TRADING_EXCHANGES=binance,kraken');
    }

    if (enableBmw) {
      envLines.push(`ALFRED_BMW_CLIENT_ID=${bmwClientId}`);
    } else {
      envLines.push('# ALFRED_BMW_CLIENT_ID=');
    }

    envLines.push('', '# === Routing ===', '');

    if (enableRouting) {
      envLines.push(`ALFRED_ROUTING_API_KEY=${routingApiKey}`);
    } else {
      envLines.push('# ALFRED_ROUTING_API_KEY=');
    }

    envLines.push('', '# === YouTube ===', '');

    if (enableYoutube) {
      envLines.push(`ALFRED_YOUTUBE_API_KEY=${youtubeApiKey}`);
      if (supadataApiKey) envLines.push(`ALFRED_SUPADATA_API_KEY=${supadataApiKey}`);
    } else {
      envLines.push('# ALFRED_YOUTUBE_API_KEY=');
      envLines.push('# ALFRED_SUPADATA_API_KEY=');
    }

    envLines.push('', '# === Energy / aWATTar ===', '');

    if (enableEnergy && energyGridUsageCt) {
      if (energyGridName) envLines.push(`ALFRED_ENERGY_GRID_NAME=${energyGridName}`);
      envLines.push(`ALFRED_ENERGY_GRID_USAGE_CT=${energyGridUsageCt}`);
      envLines.push(`ALFRED_ENERGY_GRID_LOSS_CT=${energyGridLossCt}`);
      if (energyGridCapacityFee) envLines.push(`ALFRED_ENERGY_GRID_CAPACITY_FEE=${energyGridCapacityFee}`);
      if (energyGridMeterFee) envLines.push(`ALFRED_ENERGY_GRID_METER_FEE=${energyGridMeterFee}`);
    } else {
      envLines.push('# ALFRED_ENERGY_GRID_NAME=');
      envLines.push('# ALFRED_ENERGY_GRID_USAGE_CT=');
      envLines.push('# ALFRED_ENERGY_GRID_LOSS_CT=');
      envLines.push('# ALFRED_ENERGY_GRID_CAPACITY_FEE=');
      envLines.push('# ALFRED_ENERGY_GRID_METER_FEE=');
    }

    // === Storage & File Store ===
    if (storageConnectionString) {
      envLines.push('', '# === Storage (PostgreSQL) ===', '');
      envLines.push(`ALFRED_STORAGE_CONNECTION_STRING=${storageConnectionString}`);
    }

    if (fileStoreBackend === 's3') {
      envLines.push('', '# === File Store (S3/MinIO) ===', '');
      if (fileStoreS3AccessKey) envLines.push(`ALFRED_S3_ACCESS_KEY=${fileStoreS3AccessKey}`);
      if (fileStoreS3SecretKey) envLines.push(`ALFRED_S3_SECRET_KEY=${fileStoreS3SecretKey}`);
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
      llm: Record<string, unknown>;
      search?: { provider: string; apiKey?: string; baseUrl?: string };
      email?: { accounts: Array<{ name: string; provider?: string; imap?: { host: string; port: number; secure: boolean }; smtp?: { host: string; port: number; secure: boolean }; auth?: { user: string; pass: string }; microsoft?: { clientId: string; clientSecret: string; tenantId: string; refreshToken: string } }> };
      speech?: { provider: string; apiKey: string; baseUrl?: string };
      codeSandbox?: { enabled: boolean; allowedLanguages: string[] };
      codeAgents?: { enabled: boolean; agents: SelectedAgent[]; forge?: { provider: string; github?: { token: string }; gitlab?: { token: string } } };
      proxmox?: { baseUrl: string; tokenId: string; tokenSecret: string; verifyTls: boolean };
      proxmoxBackup?: { baseUrl: string; tokenId: string; tokenSecret: string; maxAgeHours: number; verifyTls: boolean };
      unifi?: { baseUrl: string; apiKey?: string; username?: string; password?: string; site: string; verifyTls: boolean };
      homeassistant?: { baseUrl: string; accessToken: string; verifyTls: boolean };
      contacts?: { provider: string; carddav?: Record<string, string>; google?: Record<string, string>; microsoft?: Record<string, string> };
      docker?: { socketPath?: string; host?: string };
      bmw?: { clientId: string };
      routing?: { apiKey: string };
      youtube?: { apiKey: string; supadata?: { enabled: boolean; apiKey: string } };
      energy?: Record<string, unknown>;
      api: { enabled: boolean; port: number; host: string; webUi: boolean; token?: string; tls?: { enabled: boolean; cert?: string; key?: string } };
      cluster?: { enabled: boolean; nodeId: string; role: string; redisUrl: string; token: string };
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
      llm: Object.keys(configuredTiers).length > 0
        ? {
            default: {
              provider: provider.name,
              model,
              ...(baseUrl ? { baseUrl } : {}),
              temperature: 0.7,
              maxTokens: 4096,
            },
            ...configuredTiers,
          }
        : {
            provider: provider.name,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            temperature: 0.7,
            maxTokens: 4096,
          },
      ...(searchProvider ? {
        search: {
          provider: searchProvider,
          ...(searchApiKey ? { apiKey: searchApiKey } : {}),
          ...(searchBaseUrl ? { baseUrl: searchBaseUrl } : {}),
        },
      } : {}),
      ...(enableEmail && emailAccounts.length > 0 ? {
        email: {
          accounts: emailAccounts.map(acct => acct.provider === 'microsoft'
            ? {
                name: acct.name,
                provider: 'microsoft' as const,
                ...(acct.msClientId ? {
                  microsoft: {
                    clientId: acct.msClientId,
                    clientSecret: acct.msClientSecret,
                    tenantId: acct.msTenantId,
                    refreshToken: acct.msRefreshToken,
                  },
                } : {}),
              }
            : {
                name: acct.name,
                imap: { host: acct.imapHost, port: acct.imapPort, secure: acct.imapPort === 993 },
                smtp: { host: acct.smtpHost, port: acct.smtpPort, secure: acct.smtpPort === 465 },
                auth: { user: acct.user, pass: acct.pass },
              }),
        },
      } : {}),
      ...(speechProvider ? {
        speech: {
          provider: speechProvider,
          apiKey: speechApiKey,
          ...(speechBaseUrl ? { baseUrl: speechBaseUrl } : {}),
          ...(ttsEnabled ? { ttsEnabled: true, ttsVoice } : {}),
        },
      } : {}),
      ...(enableSandbox ? {
        codeSandbox: {
          enabled: true,
          allowedLanguages: ['javascript', 'python'],
        },
      } : {}),
      ...((selectedAgents.length > 0 || forgeProvider) ? {
        codeAgents: {
          enabled: selectedAgents.length > 0,
          agents: selectedAgents,
          ...(forgeProvider === 'github' ? {
            forge: {
              provider: 'github',
              github: { token: forgeGithubToken },
            },
          } : forgeProvider === 'gitlab' ? {
            forge: {
              provider: 'gitlab',
              gitlab: { token: forgeGitlabToken },
            },
          } : {}),
        },
      } : {}),
      ...(enableProxmox ? {
        proxmox: {
          baseUrl: proxmoxBaseUrl,
          tokenId: proxmoxTokenId,
          tokenSecret: proxmoxTokenSecret,
          verifyTls: proxmoxVerifyTls,
        },
      } : {}),
      ...(enablePbs ? {
        proxmoxBackup: {
          baseUrl: pbsBaseUrl,
          tokenId: pbsTokenId,
          tokenSecret: pbsTokenSecret,
          maxAgeHours: pbsMaxAgeHours,
          verifyTls: pbsVerifyTls,
        },
      } : {}),
      ...(enableUnifi ? {
        unifi: {
          baseUrl: unifiBaseUrl,
          ...(unifiApiKey ? { apiKey: unifiApiKey } : { username: unifiUsername, password: unifiPassword }),
          site: 'default',
          verifyTls: unifiVerifyTls,
        },
      } : {}),
      ...(enableHa ? {
        homeassistant: {
          baseUrl: haBaseUrl,
          accessToken: haAccessToken,
          verifyTls: haVerifyTls,
        },
      } : {}),
      ...(enableContacts ? {
        contacts: {
          provider: contactsProvider,
          ...(contactsProvider === 'carddav' ? {
            carddav: {
              serverUrl: contactsEnvEntries['ALFRED_CARDDAV_CONTACTS_SERVER_URL'],
              username: contactsEnvEntries['ALFRED_CARDDAV_CONTACTS_USERNAME'],
            },
          } : contactsProvider === 'google' ? {
            google: {
              clientId: contactsEnvEntries['ALFRED_GOOGLE_CONTACTS_CLIENT_ID'],
            },
          } : contactsProvider === 'microsoft' ? {
            microsoft: {
              clientId: contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_CLIENT_ID'],
              tenantId: contactsEnvEntries['ALFRED_MICROSOFT_CONTACTS_TENANT_ID'],
            },
          } : {}),
        },
      } : {}),
      ...(enableDocker ? {
        docker: {
          ...(dockerSocketPath ? { socketPath: dockerSocketPath } : {}),
          ...(dockerHost ? { host: dockerHost } : {}),
        },
      } : {}),
      ...(enableBmw ? {
        bmw: { clientId: bmwClientId },
      } : {}),
      ...(enableRouting ? {
        routing: { apiKey: routingApiKey },
      } : {}),
      ...(enableYoutube ? {
        youtube: {
          apiKey: youtubeApiKey,
          ...(supadataApiKey ? { supadata: { enabled: true, apiKey: supadataApiKey } } : {}),
        },
      } : {}),
      ...(enableEnergy && energyGridUsageCt ? {
        energy: {
          ...(energyGridName ? { gridName: energyGridName } : {}),
          gridUsageCt: parseFloat(energyGridUsageCt),
          gridLossCt: parseFloat(energyGridLossCt || '0'),
          ...(energyGridCapacityFee ? { gridCapacityFee: parseFloat(energyGridCapacityFee) } : {}),
          ...(energyGridMeterFee ? { gridMeterFee: parseFloat(energyGridMeterFee) } : {}),
        },
      } : {}),
      api: {
        enabled: true,
        port: 3420,
        host: apiHost,
        webUi: enableWebUi,
        ...(apiToken ? { token: apiToken } : {}),
        ...(enableTls ? { tls: { enabled: true } } : {}),
      },
      ...(clusterEnabled ? {
        cluster: {
          enabled: true,
          nodeId: clusterNodeId,
          role: clusterRole,
          redisUrl: clusterRedisUrl,
          token: clusterToken,
        },
      } : {}),
      storage: {
        path: './data/alfred.db',
        ...(storageBackend === 'postgres' ? { backend: 'postgres' as const } : {}),
        ...(storageConnectionString ? { connectionString: storageConnectionString } : {}),
      },
      ...(fileStoreBackend !== 'local' ? {
        fileStore: {
          backend: fileStoreBackend,
          ...(fileStoreBasePath ? { basePath: fileStoreBasePath } : {}),
          ...(fileStoreS3Endpoint ? { s3Endpoint: fileStoreS3Endpoint } : {}),
          ...(fileStoreS3Bucket ? { s3Bucket: fileStoreS3Bucket } : {}),
          ...(fileStoreS3AccessKey ? { s3AccessKey: fileStoreS3AccessKey } : {}),
          ...(fileStoreS3SecretKey ? { s3SecretKey: fileStoreS3SecretKey } : {}),
        },
      } : {}),
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

    // ── 10b. Generate config/rules/default-rules.yml ──────────────
    const rulesDir = path.join(configDir, 'rules');
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    const ownerAdminRule = enableShell && ownerUserId
      ? `
  # Allow admin actions (shell, etc.) for the owner only
  - id: allow-owner-admin
    effect: allow
    priority: 50
    scope: global
    actions: ["*"]
    riskLevels: [admin, destructive]
    conditions:
      users: ["${ownerUserId}"]
`
      : `
  # Allow admin actions (shell, etc.) for the owner only
  # Uncomment and set your user ID to enable:
  # - id: allow-owner-admin
  #   effect: allow
  #   priority: 50
  #   scope: global
  #   actions: ["*"]
  #   riskLevels: [admin, destructive]
  #   conditions:
  #     users: ["${ownerUserId || 'YOUR_USER_ID_HERE'}"]
`;

    const writeRule = writeInGroups
      ? `  # Allow write-level skills everywhere (DMs and groups)
  - id: allow-write-all
    effect: allow
    priority: 200
    scope: global
    actions: ["*"]
    riskLevels: [write]`
      : `  # Allow write-level skills in DMs only
  - id: allow-write-for-dm
    effect: allow
    priority: 200
    scope: global
    actions: ["*"]
    riskLevels: [write]
    conditions:
      chatType: dm`;

    const rulesYaml = `# Alfred — Default Security Rules
# Rules are evaluated in priority order (lower number = higher priority).
# First matching rule wins.

rules:
  # Allow all read-level skills (calculator, system_info, web_search) for everyone
  - id: allow-all-read
    effect: allow
    priority: 100
    scope: global
    actions: ["*"]
    riskLevels: [read]

${writeRule}

  # Rate-limit write actions: max ${rateLimit} per hour per user
  - id: rate-limit-write
    effect: allow
    priority: 250
    scope: user
    actions: ["*"]
    riskLevels: [write]
    rateLimit:
      maxInvocations: ${rateLimit}
      windowSeconds: 3600
${ownerAdminRule}
  # Deny destructive and admin actions by default
  - id: deny-destructive
    effect: deny
    priority: 500
    scope: global
    actions: ["*"]
    riskLevels: [destructive, admin]

  # Catch-all deny
  - id: deny-default
    effect: deny
    priority: 9999
    scope: global
    actions: ["*"]
    riskLevels: [read, write, destructive, admin]
`;

    const rulesPath = path.join(rulesDir, 'default-rules.yml');
    fs.writeFileSync(rulesPath, rulesYaml, 'utf-8');
    console.log(`  ${green('+')} ${dim('config/rules/default-rules.yml')} written`);

    // ── 11. Ensure data/ directory exists ─────────────────────────
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
    console.log(`  ${bold('LLM default:')}    ${provider.name} (${model})`);
    if (apiKey) {
      console.log(`  ${bold('API key:')}        ${maskKey(apiKey)}`);
    }
    for (const [tierKey, tierCfg] of Object.entries(configuredTiers)) {
      const label = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
      console.log(`  ${bold(`LLM ${label}:`)}${' '.repeat(Math.max(1, 10 - label.length))}${tierCfg.provider} (${tierCfg.model})`);
    }
    if (selectedPlatforms.length > 0) {
      console.log(
        `  ${bold('Platforms:')}      ${selectedPlatforms.map((p) => p.label).join(', ')}`,
      );
    } else {
      console.log(`  ${bold('Platforms:')}      none (configure later)`);
    }
    if (searchProvider) {
      const searchLabelMap: Record<string, string> = {
        brave: 'Brave Search',
        tavily: 'Tavily',
        duckduckgo: 'DuckDuckGo',
        searxng: `SearXNG (${searchBaseUrl})`,
      };
      console.log(`  ${bold('Web search:')}     ${searchLabelMap[searchProvider]}`);
    } else {
      console.log(`  ${bold('Web search:')}     ${dim('disabled')}`);
    }
    if (enableEmail && emailAccounts.length > 0) {
      const accountSummaries = emailAccounts.map(acct => {
        if (acct.provider === 'microsoft') {
          return `${acct.name} (Microsoft 365)${acct.msClientId ? '' : ' — shared from Calendar'}`;
        }
        return `${acct.name} (${acct.imapHost})`;
      });
      console.log(`  ${bold('Email:')}          ${accountSummaries.join(', ')}`);
    } else {
      console.log(`  ${bold('Email:')}          ${dim('disabled')}`);
    }
    if (speechProvider) {
      const speechLabelMap: Record<string, string> = {
        openai: 'OpenAI Whisper',
        groq: 'Groq Whisper',
      };
      const ttsLabel = ttsEnabled ? `, TTS: ${ttsVoice}` : '';
      console.log(`  ${bold('Voice:')}          ${speechLabelMap[speechProvider]}${ttsLabel}`);
    } else {
      console.log(`  ${bold('Voice:')}          ${dim('disabled')}`);
    }
    console.log(`  ${bold('Code Sandbox:')}  ${enableSandbox ? green('enabled') : dim('disabled')}`);
    console.log(`  ${bold('Web Chat UI:')}   ${enableWebUi ? green('enabled (/alfred/)') : dim('disabled')}`);
    console.log(`  ${bold('TLS/HTTPS:')}    ${enableTls ? green('enabled (self-signed)') : dim('disabled')}`);
    if (storageBackend === 'postgres') {
      console.log(`  ${bold('Storage:')}       ${green('PostgreSQL')}`);
    }
    if (fileStoreBackend !== 'local') {
      console.log(`  ${bold('File Store:')}    ${green(fileStoreBackend.toUpperCase())}${fileStoreBackend === 's3' ? ` (${fileStoreS3Bucket})` : ` (${fileStoreBasePath})`}`);
    }
    if (clusterEnabled) {
      console.log(`  ${bold('Cluster:')}       ${green(`${clusterRole} (${clusterNodeId})`)}`);
      console.log(`  ${bold('Redis:')}         ${clusterRedisUrl}`);
    }
    if (enableYoutube) console.log(`  ${bold('YouTube:')}       ${green('enabled')}${supadataApiKey ? ' + Supadata' : ''}`);
    if (enableProxmox) console.log(`  ${bold('Proxmox:')}       ${green(proxmoxBaseUrl)}`);
    if (enablePbs) console.log(`  ${bold('PBS:')}           ${green(pbsBaseUrl)} ${dim(`(max age: ${pbsMaxAgeHours}h)`)}`);
    if (enableUnifi) console.log(`  ${bold('UniFi:')}         ${green(unifiBaseUrl)}`);
    if (enableHa) console.log(`  ${bold('Home Assist.:')} ${green(haBaseUrl)}`);
    if (enableContacts) console.log(`  ${bold('Contacts:')}      ${green(contactsProvider)}`);
    if (enableDocker) console.log(`  ${bold('Docker:')}        ${green(dockerHost || dockerSocketPath)}`);
    if (enableBmw) console.log(`  ${bold('BMW CarData:')}   ${green('enabled')}`);
    if (enableRouting) console.log(`  ${bold('Routing:')}       ${green('enabled')}`);
    if (enableEnergy) console.log(`  ${bold('Energy:')}        ${green(energyGridName || 'enabled')} ${dim(`(${energyGridUsageCt} ct/kWh)`)}`);

    if (ownerUserId) {
      console.log(`  ${bold('Owner ID:')}       ${ownerUserId}`);
      console.log(`  ${bold('Shell access:')}   ${enableShell ? green('enabled') : dim('disabled')}`);
    }
    console.log(`  ${bold('Write scope:')}    ${writeInGroups ? 'DMs + Groups' : 'DMs only'}`);
    console.log(`  ${bold('Rate limit:')}     ${rateLimit}/hour per user`);
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
