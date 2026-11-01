import { PasswordResetService } from './password-reset.service';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { WebHandoffService } from './web-handoff.service';

@Module({
  controllers: [AuthController],
  providers: [
    PasswordResetService,
    AuthService,
    TokenService,
    WebHandoffService,
  ],
  exports: [TokenService],
})
export class AuthModule {}
