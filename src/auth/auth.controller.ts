import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { users } from '../db/types';
import {
  CurrentTokenId,
  CurrentUser,
  Public,
} from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { LIMITS, RateLimit } from '../common/decorators/rate-limit';
import { Client, type ClientInfo } from '../common/decorators/client.decorator';
import { RateLimiter } from '../common/rate-limiter';
import { AuthService, phoneKey } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import {
  LoginDto,
  RegisterDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { TokenService } from './token.service';
import { WebHandoffService } from './web-handoff.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** /api/v1/auth/* — same contract as api.md §3. */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly resets: PasswordResetService,
    private readonly handoff: WebHandoffService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Forgot-password (legacy PasswordResetController::sendLink). The link was
   * sent: 200 with the status. An unknown address or a repeat request within a
   * minute: 422 with the status under `email`, as Laravel answers JSON callers
   * (the legacy web form flashed every outcome as a status; the mobile app needs
   * to tell them apart).
   */
  @Public()
  @RateLimit(LIMITS.auth)
  @Post('password/forgot')
  @HttpCode(200)
  async forgotPassword(@Body() body: unknown) {
    // security: not in legacy — always 200 with the same message (see sendLink).
    return ok(null, await this.resets.sendLink(body));
  }

  /** Web reset-password (legacy PasswordResetController::update). Failures are an `email` error (422). */
  @Public()
  @RateLimit(LIMITS.auth)
  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(@Body() body: unknown) {
    return ok(null, await this.resets.reset(body));
  }

  @Public()
  @RateLimit(LIMITS.auth)
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const { result, message } = await this.auth.register(dto);
    return ok(result, message);
  }

  /** Data for the B2C sign-up form (legacy web `GET /register/student`). */
  @Public()
  @Get('register/student')
  async studentSignupOptions(
    @Query('plan') plan: unknown,
    @Query('cycle') cycle: unknown,
  ) {
    return ok(await this.auth.studentSignupOptions(plan, cycle));
  }

  /** B2C sign-up (legacy web `POST /register/student`): account, trial, token. */
  @Public()
  @RateLimit(LIMITS.auth)
  @Post('register/student')
  async registerStudent(@Body() body: unknown) {
    const { result, message } = await this.auth.registerStudent(body);
    return ok(result, message);
  }

  @Public()
  @RateLimit(LIMITS.auth)
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    return ok(await this.auth.login(dto), 'Logged in.');
  }

  // The OTP routes check OTP_LOGIN_ENABLED before they count against the
  // extra limits below (a disabled feature answers 503 without touching state).
  @Public()
  @RateLimit(LIMITS.otp, 'phone')
  @Post('otp/send')
  @HttpCode(200)
  async sendOtp(@Body() dto: SendOtpDto, @Client() client: ClientInfo) {
    this.auth.assertOtpEnabled();
    // security: not in legacy: also per IP and per normalised phone per hour
    // (the route limit above is per raw phone string, 3 a minute).
    await this.limiter.hit('otp-send-ip', client.ip ?? '', 20, HOUR);
    await this.limiter.hit('otp-send-phone', phoneKey(dto.phone), 10, HOUR);
    return ok(await this.auth.sendOtp(dto), 'OTP sent.');
  }

  @Public()
  @RateLimit(LIMITS.auth)
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    this.auth.assertOtpEnabled();
    // security: not in legacy: per phone as well as per IP (the route limit above),
    // so guesses spread over many addresses still stop.
    await this.limiter.hit(
      'otp-verify-phone',
      phoneKey(dto.phone),
      10,
      10 * MINUTE,
    );
    return ok(await this.auth.verifyOtp(dto), 'Phone verified.');
  }

  /**
   * not in legacy: a single-use link that opens `next` on the web already
   * signed in (the mobile app opens it in the browser). Any role.
   */
  // security: not in legacy: 10 codes an hour per user.
  @RateLimit(10, 'user', HOUR)
  @Post('web-handoff')
  @HttpCode(200)
  async webHandoff(@CurrentUser() user: users, @Body() body: unknown) {
    return ok(await this.handoff.issue(user, body));
  }

  /**
   * not in legacy: who a code would sign in, without using it, so the web can
   * ask "Continue as {name}?" before redeeming. Same errors as redeem.
   */
  @Public()
  @RateLimit(LIMITS.auth)
  @Post('web-handoff/peek')
  @HttpCode(200)
  async peekWebHandoff(@Body() body: unknown) {
    return ok(await this.handoff.peek(body));
  }

  /** not in legacy: the web redeems the code for a session token (like login, plus `next`). */
  @Public()
  @RateLimit(LIMITS.auth)
  @Post('web-handoff/redeem')
  @HttpCode(200)
  async redeemWebHandoff(@Body() body: unknown) {
    return ok(await this.handoff.redeem(body), 'Logged in.');
  }

  @Get('me')
  async me(@CurrentUser() user: users) {
    return ok(await this.auth.me(user));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentTokenId() tokenId: bigint) {
    await this.tokens.revoke(tokenId);
    return ok(null, 'Logged out.');
  }

  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: users) {
    await this.tokens.revokeAll(user.id);
    return ok(null, 'All sessions cleared.');
  }
}
