import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import type { AiConfig } from '../integrations/integrations';
import { SYSTEM_PROMPT } from './ai-tutor';

/**
 * The legacy default model (config `ANTHROPIC_MODEL`, unchanged for parity).
 * not in legacy: overridden under Integrations → AI tutor (empty = this).
 */
const LEGACY_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** A live reply and what Anthropic billed for it. */
export interface ClaudeReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** The settings a live call uses (Integrations → AI tutor). */
export interface LiveAi {
  apiKey: string;
  model: string;
  /** `max_tokens` for one reply (default 1024). */
  maxTokens: number;
}

const liveOf = (c: AiConfig): LiveAi | null =>
  c.api_key
    ? {
        apiKey: c.api_key,
        model: c.model || LEGACY_DEFAULT_MODEL,
        maxTokens: c.max_tokens || 1024,
      }
    : null;

/**
 * Thin wrapper over the Anthropic Messages API for the AI tutor.
 * Returns null when no key is configured or the call fails, so callers can fall
 * back to the canned reply (AiService::generateAssistantResponse).
 * Settings are read per call; the SDK client is rebuilt when the key changes.
 */
@Injectable()
export class ClaudeClient {
  private readonly logger = new Logger(ClaudeClient.name);
  private client: { key: string; sdk: Anthropic } | null = null;

  constructor(private readonly settings: IntegrationSettingsService) {}

  /** The live settings, or null when no API key is saved. */
  async live(): Promise<LiveAi | null> {
    return liveOf(await this.settings.get('ai'));
  }

  private sdk(apiKey: string): Anthropic {
    if (this.client?.key !== apiKey)
      // 60 s per attempt (the SDK default is 10 min); the student is waiting on this.
      this.client = {
        key: apiKey,
        sdk: new Anthropic({ apiKey, timeout: 60_000 }),
      };
    return this.client.sdk;
  }

  /** not in legacy: the super admin's "Test": a one-token completion. Throws on failure. */
  async test(): Promise<string> {
    const live = await this.live();
    if (!live) throw new Error('No API key is saved.');
    const response = await this.sdk(live.apiKey).messages.create({
      model: live.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return response.model;
  }

  async reply(
    messages: Anthropic.MessageParam[],
    context: { sessionId: bigint },
    live?: LiveAi | null,
  ): Promise<ClaudeReply | null> {
    live ??= await this.live();
    if (!live) return null;
    try {
      const response = await this.sdk(live.apiKey).messages.create({
        model: live.model,
        max_tokens: live.maxTokens,
        system: SYSTEM_PROMPT,
        messages,
      });
      if (response.stop_reason === 'refusal') return null;
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) return null;
      // security: not in legacy: the real usage, so the daily budget is metered on it.
      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      const kind =
        error instanceof Anthropic.RateLimitError
          ? 'rate_limited'
          : error instanceof Anthropic.AuthenticationError
            ? 'auth'
            : error instanceof Anthropic.APIError
              ? `api_${error.status}`
              : 'network';
      this.logger.warn(
        `Anthropic call failed (${kind}); falling back to stub. session=${context.sessionId} ${String(error)}`,
      );
      return null;
    }
  }
}
