import type { ForgeConfig, GitHubForgeConfig, GitLabForgeConfig } from '@alfred/types';

// ── Interfaces ──────────────────────────────────────────────────────────

export interface RepoIdentifier {
  owner: string;
  repo: string;
}

export interface PullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResult {
  id: number;
  url: string;
  number: number;
  state: string;
}

export interface PipelineStatus {
  state: 'pending' | 'running' | 'success' | 'failure' | 'unknown';
  url?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  visibility?: 'private' | 'public';
}

export interface CreateProjectResult {
  id: number;
  url: string;
  cloneUrl: string;
}

// ── Abstract Client ─────────────────────────────────────────────────────

export abstract class ForgeClient {
  abstract createPullRequest(repo: RepoIdentifier, input: PullRequestInput): Promise<PullRequestResult>;
  abstract getPipelineStatus(repo: RepoIdentifier, ref: string): Promise<PipelineStatus>;
  abstract createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
}

// ── GitHub ───────────────────────────────────────────────────────────────

class GitHubForgeClient extends ForgeClient {
  private readonly baseUrl: string;

  constructor(private readonly config: GitHubForgeConfig) {
    super();
    this.baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://api.github.com';
  }

  async createPullRequest(repo: RepoIdentifier, input: PullRequestInput): Promise<PullRequestResult> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/pulls`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub PR creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: data.id as number,
      url: data.html_url as string,
      number: data.number as number,
      state: data.state as string,
    };
  }

  async getPipelineStatus(repo: RepoIdentifier, ref: string): Promise<PipelineStatus> {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/commits/${ref}/status`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      return { state: 'unknown' };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const ghState = data.state as string;
    const stateMap: Record<string, PipelineStatus['state']> = {
      pending: 'pending',
      success: 'success',
      failure: 'failure',
      error: 'failure',
    };
    return { state: stateMap[ghState] ?? 'unknown' };
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const url = `${this.baseUrl}/user/repos`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? '',
        private: (input.visibility ?? 'private') === 'private',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub project creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: data.id as number,
      url: data.html_url as string,
      cloneUrl: data.clone_url as string,
    };
  }
}

// ── GitLab ──────────────────────────────────────────────────────────────

class GitLabForgeClient extends ForgeClient {
  private readonly baseUrl: string;

  constructor(private readonly config: GitLabForgeConfig) {
    super();
    this.baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://gitlab.com';
  }

  async createPullRequest(repo: RepoIdentifier, input: PullRequestInput): Promise<PullRequestResult> {
    const projectPath = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    const url = `${this.baseUrl}/api/v4/projects/${projectPath}/merge_requests`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.config.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        description: input.body,
        source_branch: input.head,
        target_branch: input.base,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitLab MR creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: data.id as number,
      url: data.web_url as string,
      number: data.iid as number,
      state: data.state as string,
    };
  }

  async getPipelineStatus(repo: RepoIdentifier, ref: string): Promise<PipelineStatus> {
    const projectPath = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    const url = `${this.baseUrl}/api/v4/projects/${projectPath}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`;
    const res = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': this.config.token },
    });

    if (!res.ok) {
      return { state: 'unknown' };
    }

    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (data.length === 0) {
      return { state: 'unknown' };
    }

    const pipeline = data[0];
    const glStatus = pipeline.status as string;
    const stateMap: Record<string, PipelineStatus['state']> = {
      pending: 'pending',
      running: 'running',
      success: 'success',
      failed: 'failure',
      canceled: 'failure',
    };
    return {
      state: stateMap[glStatus] ?? 'unknown',
      url: pipeline.web_url as string | undefined,
    };
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const url = `${this.baseUrl}/api/v4/projects`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.config.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? '',
        visibility: input.visibility ?? 'private',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitLab project creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: data.id as number,
      url: data.web_url as string,
      cloneUrl: data.http_url_to_repo as string,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createForgeClient(config: ForgeConfig): ForgeClient {
  switch (config.provider) {
    case 'github': {
      if (!config.github) throw new Error('ForgeConfig.github is required when provider is "github"');
      return new GitHubForgeClient(config.github);
    }
    case 'gitlab': {
      if (!config.gitlab) throw new Error('ForgeConfig.gitlab is required when provider is "gitlab"');
      return new GitLabForgeClient(config.gitlab);
    }
    default:
      throw new Error(`Unknown forge provider: ${config.provider as string}`);
  }
}
