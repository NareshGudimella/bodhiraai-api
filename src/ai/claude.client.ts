import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { SYSTEM_PROMPT } from './ai-tutor';

/**
 * The legacy default model (config `ANTHROPIC_MODEL`, unchanged for parity).
 * Override per environment with ANTHROPIC_MODEL.
 */
const LEGACY_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** A live reply and what Anthropic billed for it. */
export interface ClaudeReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** `max_tokens` for one reply (ANTHROPIC_MAX_TOKENS, default 1024). */
export const maxReplyTokens = () =>
  Number(process.env.ANTHROPIC_MAX_TOKENS) || 1024;

/**
 * Thin wrapper over the Anthropic Messages API for the AI tutor.
 * Returns null when no key is configured or the call fails, so callers can fall
 * back to the canned reply (AiService::generateAssistantResponse).
 */
@Injectable()
export class ClaudeClient {
  private readonly logger = new Logger(ClaudeClient.name);
  private client: Anthropic | null = null;

  private get apiKey() {
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
  }

  get configured() {
    return this.apiKey !== '';
  }

  private sdk(): Anthropic {
    // 60 s per attempt (the SDK default is 10 min); the student is waiting on this.
    this.client ??= new Anthropic({ apiKey: this.apiKey, timeout: 60_000 });
    return this.client;
  }

  async reply(
    messages: Anthropic.MessageParam[],
    context: { sessionId: bigint },
  ): Promise<ClaudeReply | null> {
    if (!this.configured) return null;
    try {
      const response = await this.sdk().messages.create({
        model: process.env.ANTHROPIC_MODEL || LEGACY_DEFAULT_MODEL,
        max_tokens: maxReplyTokens(),
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
