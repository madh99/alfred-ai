import type {
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from '@alfred/types';

export abstract class LLMProvider {
  protected config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract complete(request: LLMRequest): Promise<LLMResponse>;
  abstract stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  abstract isAvailable(): boolean;
}
