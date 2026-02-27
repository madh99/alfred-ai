import type { Logger } from 'pino';
import type { MCPConfig } from '@alfred/types';
import { MCPClient } from './mcp-client.js';
import { MCPSkillAdapter } from './mcp-skill-adapter.js';
import type { Skill } from '../skill.js';

export class MCPManager {
  private readonly clients: MCPClient[] = [];
  private readonly skills: Skill[] = [];

  constructor(private readonly logger: Logger) {}

  async initialize(config: MCPConfig): Promise<void> {
    for (const serverConfig of config.servers) {
      try {
        const client = new MCPClient(serverConfig.name, serverConfig, this.logger.child({ mcp: serverConfig.name }));
        await client.connect();
        this.clients.push(client);

        const tools = await client.listTools();
        for (const tool of tools) {
          const adapted = new MCPSkillAdapter(client, serverConfig.name, tool.name, tool.description ?? '', tool.inputSchema);
          this.skills.push(adapted);
        }
        this.logger.info({ server: serverConfig.name, tools: tools.length }, 'MCP server initialized');
      } catch (err) {
        this.logger.error({ server: serverConfig.name, err }, 'Failed to initialize MCP server');
      }
    }
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients) {
      await client.disconnect();
    }
    this.clients.length = 0;
    this.skills.length = 0;
  }
}
