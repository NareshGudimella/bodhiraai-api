import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { users } from '../db/types';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { LIMITS, RateLimit } from '../common/decorators/rate-limit';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { iso8601, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { validateBody } from '../common/http/validation';
import { SubscribedGuard } from '../student/subscribed.guard';
import { AiService } from './ai.service';

class StartSessionDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) body?: string | null;
}

class ReplyDto {
  @IsString() @MaxLength(4000) body!: string;
}

const LIMIT_REACHED = 'Daily AI token limit reached. Resets tomorrow.';

const messageJson = (m: {
  id: bigint;
  role: string;
  content: string;
  created_at: Date | null;
}) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  created_at: iso8601(m.created_at),
});

/**
 * /api/v1/student/ai/* — port of Api\V1\Student\AiApiController (throttle:ai, per user).
 * security: not in legacy API: every route sits behind the paywall (402), as
 * the legacy web's `subscribed` middleware did for /student/ai.
 */
@Controller('student/ai')
@Roles(Role.Student)
@UseGuards(SubscribedGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('sessions')
  @RateLimit(LIMITS.ai, 'user')
  async sessions(@CurrentUser() user: users) {
    const rows = await this.ai.sessions(user);
    return ok(
      rows.map((s) => ({
        id: s.id,
        title: s.title,
        mode: s.mode,
        messages_count: s.messages_count,
        last_message_at: iso8601(s.last_message_at),
        updated_at: iso8601(s.updated_at),
      })),
    );
  }

  @Post('sessions')
  @RateLimit(LIMITS.ai, 'user')
  async start(@CurrentUser() user: users, @Body() dto: StartSessionDto) {
    // PHP empty(): null, '' and '0' all count as "no body".
    const hasBody = !!dto.body && dto.body !== '0';
    if (hasBody && (await this.ai.remainingTokens(user)) <= 0) {
      throw new ApiException(LIMIT_REACHED, 429);
    }
    const session = await this.ai.startSession(user, dto.title);
    let title = session.title;
    let lastMessageAt = session.last_message_at;
    const messages = [];
    if (hasBody) {
      const sent = await this.ai.sendMessage(user, session, dto.body!.trim());
      messages.push(messageJson(sent.user), messageJson(sent.assistant));
      title = sent.title;
      lastMessageAt = sent.assistant.created_at;
    }
    return ok(
      {
        session: {
          id: session.id,
          title,
          last_message_at: iso8601(lastMessageAt),
        },
        messages,
        tokens: await this.ai.tokenStatus(user),
      },
      'Session started.',
    );
  }

  @Get('sessions/:session')
  @RateLimit(LIMITS.ai, 'user')
  async show(@CurrentUser() user: users, @Param('session') raw: string) {
    const session = await this.ai.ownSession(
      user,
      routeId(raw, 'AiChatSession'),
    );
    const messages = await this.ai.messages(session.id);
    return ok({
      session: {
        id: session.id,
        title: session.title,
        last_message_at: iso8601(session.last_message_at),
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        tokens: m.tokens,
        created_at: iso8601(m.created_at),
      })),
    });
  }

  @Post('sessions/:session/messages')
  @HttpCode(200)
  @RateLimit(LIMITS.ai, 'user')
  async reply(
    @CurrentUser() user: users,
    @Param('session') raw: string,
    @Body() body: unknown,
  ) {
    // Laravel order: binding and guard (404/403) before validation (422).
    const session = await this.ai.ownSession(
      user,
      routeId(raw, 'AiChatSession'),
    );
    const dto = await validateBody(ReplyDto, body);
    if ((await this.ai.remainingTokens(user)) <= 0) {
      throw new ApiException(LIMIT_REACHED, 429);
    }
    const sent = await this.ai.sendMessage(user, session, dto.body.trim());
    return ok(
      {
        user: messageJson(sent.user),
        assistant: messageJson(sent.assistant),
        tokens: await this.ai.tokenStatus(user),
      },
      'Reply generated.',
    );
  }

  @Get('recommendations')
  @RateLimit(LIMITS.ai, 'user')
  async recommendations(@CurrentUser() user: users) {
    return ok(await this.ai.recommendations(user));
  }

  /**
   * New (not in the legacy API): the daily token meter on its own. The legacy
   * web page read it server-side; the API only returned it after start/reply.
   * Not rate-limited, so page loads don't spend the student's AI allowance.
   */
  @Get('tokens')
  async tokens(@CurrentUser() user: users) {
    return ok(await this.ai.tokenStatus(user));
  }
}
