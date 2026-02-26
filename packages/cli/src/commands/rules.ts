import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ConfigLoader } from '@alfred/config';
import { RuleLoader } from '@alfred/security';
import type { SecurityRule } from '@alfred/types';

export async function rulesCommand(): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  const rulesPath = path.resolve(config.security.rulesPath);

  if (!fs.existsSync(rulesPath)) {
    console.log(`Rules directory not found: ${rulesPath}`);
    console.log('No security rules loaded.');
    return;
  }

  const stat = fs.statSync(rulesPath);
  if (!stat.isDirectory()) {
    console.error(`Rules path is not a directory: ${rulesPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(rulesPath).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  );

  if (files.length === 0) {
    console.log(`No YAML rule files found in: ${rulesPath}`);
    return;
  }

  const ruleLoader = new RuleLoader();
  const allRules: SecurityRule[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const filePath = path.join(rulesPath, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw) as { rules: unknown[] };
      const rules = ruleLoader.loadFromObject(parsed);
      allRules.push(...rules);
    } catch (error) {
      errors.push(`  ${file}: ${(error as Error).message}`);
    }
  }

  console.log('Alfred — Security Rules');
  console.log('=======================');
  console.log(`Rules directory: ${rulesPath}`);
  console.log(`Rule files found: ${files.length}`);
  console.log(`Total rules loaded: ${allRules.length}`);
  console.log('');

  if (errors.length > 0) {
    console.log('Errors:');
    for (const err of errors) {
      console.log(err);
    }
    console.log('');
  }

  if (allRules.length === 0) {
    return;
  }

  // Sort by priority (lower = higher priority)
  allRules.sort((a, b) => a.priority - b.priority);

  console.log('Loaded rules (sorted by priority):');
  console.log('');

  for (const rule of allRules) {
    const rateLimit = rule.rateLimit
      ? ` | rate-limit: ${rule.rateLimit.maxInvocations}/${rule.rateLimit.windowSeconds}s`
      : '';
    console.log(`  [${rule.priority}] ${rule.id}`);
    console.log(`       effect: ${rule.effect} | scope: ${rule.scope}`);
    console.log(`       actions: ${rule.actions.join(', ')}`);
    console.log(`       risk levels: ${rule.riskLevels.join(', ')}${rateLimit}`);
    if (rule.conditions) {
      console.log(`       conditions: ${JSON.stringify(rule.conditions)}`);
    }
    console.log('');
  }
}
