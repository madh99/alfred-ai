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
  email?: { imap?: { host?: string; port?: number }; smtp?: { host?: string; port?: number }; auth?: { user?: string; pass?: string } };
  codeSandbox?: { enabled?: boolean; allowedLanguages?: string[] };
}

function loadExistingConfig(projectRoot: string): {
  config: ExistingConfig;
  env: Record<string, string>;
  shellEnabled: boolean;
  writeInGroups: boolean;
  rateLimit: number;
  codeSandboxEnabled: boolean;
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

  return { config, env, shellEnabled, writeInGroups, rateLimit, codeSandboxEnabled, multiModelTiers };
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
    if (provider.models && provider.models.length > 0) {
      console.log(`${bold('Available models:')}`);
      for (let i = 0; i < provider.models.length; i++) {
        const m = provider.models[i];
        const marker = m.id === existingModel ? ` ${green('(current)')}` : '';
        console.log(`  ${cyan(`${i + 1})`)} ${m.id} ${dim(`— ${m.desc}`)}${marker}`);
      }
      console.log(`  ${cyan(`${provider.models.length + 1})`)} ${dim('Other (enter manually)')}`);
      const choice = await askWithDefault(rl, 'Choose model', '1');
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < provider.models.length) {
        model = provider.models[idx].id;
      } else if (idx === provider.models.length) {
        model = await askWithDefault(rl, 'Model ID', existingModel);
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
        console.log(`  ${dim('Press Enter to skip.')}`);

        const tierModelAnswer = (
          await rl.question(`  ${YELLOW}Model: ${RESET}${hasExisting ? dim(`[${existingTier!.model}] `) : ''}`)
        ).trim();

        const tierModel = tierModelAnswer || (hasExisting ? existingTier!.model! : '');
        if (!tierModel) {
          console.log(`    ${dim('Skipped.')}`);
          continue;
        }

        // Provider: default to same as main provider, or existing tier provider
        const tierProviderDefault = existingTier?.provider ?? provider.name;
        const tierProviderNames = PROVIDERS.map(p => p.name).join(', ');
        console.log(`  ${dim(`Providers: ${tierProviderNames}`)}`);
        const tierProviderAnswer = (
          await rl.question(`  ${YELLOW}Provider: ${RESET}${dim(`[${tierProviderDefault}] `)}`)
        ).trim();
        const tierProvider = tierProviderAnswer || tierProviderDefault;

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

    // ── 7. Email configuration ──────────────────────────────────
    const existingEmailUser = existing.config.email?.auth?.user ?? existing.env['ALFRED_EMAIL_USER'] ?? '';
    const hasEmail = !!existingEmailUser;
    const emailDefault = hasEmail ? 'Y/n' : 'y/N';
    console.log(`\n${bold('Email access (read & send emails via IMAP/SMTP)?')}`);
    console.log(`${dim('Works with Gmail, Outlook, or any IMAP/SMTP provider.')}`);
    const emailAnswer = (
      await rl.question(`${YELLOW}> ${RESET}${dim(`[${emailDefault}] `)}`)
    ).trim().toLowerCase();
    const enableEmail = emailAnswer === '' ? hasEmail : (emailAnswer === 'y' || emailAnswer === 'yes');

    let emailUser = '';
    let emailPass = '';
    let emailImapHost = '';
    let emailImapPort = 993;
    let emailSmtpHost = '';
    let emailSmtpPort = 587;

    if (enableEmail) {
      console.log('');
      emailUser = await askWithDefault(rl, '  Email address', existingEmailUser || '');
      if (!emailUser) {
        emailUser = await askRequired(rl, '  Email address');
      }

      const existingPass = existing.env['ALFRED_EMAIL_PASS'] ?? '';
      if (existingPass) {
        emailPass = await askWithDefault(rl, '  Password / App password', existingPass);
      } else {
        console.log(`  ${dim('For Gmail: use an App Password (not your regular password)')}`);
        console.log(`  ${dim('  → Google Account → Security → 2-Step → App passwords')}`);
        emailPass = await askRequired(rl, '  Password / App password');
      }

      // Auto-detect IMAP/SMTP settings based on email domain
      const domain = emailUser.split('@')[1]?.toLowerCase() ?? '';
      const presets: Record<string, { imap: string; smtp: string }> = {
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

      const preset = presets[domain];
      const defaultImap = existing.config.email?.imap?.host ?? preset?.imap ?? `imap.${domain}`;
      const defaultSmtp = existing.config.email?.smtp?.host ?? preset?.smtp ?? `smtp.${domain}`;
      const defaultImapPort = existing.config.email?.imap?.port ?? 993;
      const defaultSmtpPort = existing.config.email?.smtp?.port ?? 587;

      if (preset) {
        console.log(`  ${green('>')} Detected ${domain} — using preset server settings`);
      }

      emailImapHost = await askWithDefault(rl, '  IMAP server', defaultImap);
      const imapPortStr = await askWithDefault(rl, '  IMAP port', String(defaultImapPort));
      emailImapPort = parseInt(imapPortStr, 10) || 993;

      emailSmtpHost = await askWithDefault(rl, '  SMTP server', defaultSmtp);
      const smtpPortStr = await askWithDefault(rl, '  SMTP port', String(defaultSmtpPort));
      emailSmtpPort = parseInt(smtpPortStr, 10) || 587;

      console.log(`  ${green('>')} Email: ${dim(emailUser)} via ${dim(emailImapHost)}`);
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

    if (enableEmail) {
      envLines.push(`ALFRED_EMAIL_USER=${emailUser}`);
      envLines.push(`ALFRED_EMAIL_PASS=${emailPass}`);
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
      email?: { imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number; secure: boolean }; auth: { user: string; pass: string } };
      speech?: { provider: string; apiKey: string; baseUrl?: string };
      codeSandbox?: { enabled: boolean; allowedLanguages: string[] };
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
      ...(enableEmail ? {
        email: {
          imap: { host: emailImapHost, port: emailImapPort, secure: emailImapPort === 993 },
          smtp: { host: emailSmtpHost, port: emailSmtpPort, secure: emailSmtpPort === 465 },
          auth: { user: emailUser, pass: emailPass },
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
    if (enableEmail) {
      console.log(`  ${bold('Email:')}          ${emailUser} (${emailImapHost})`);
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
