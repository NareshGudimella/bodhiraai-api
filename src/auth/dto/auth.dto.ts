import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../common/roles';
import {
  CURRENT_PASSWORD_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_RE,
  PHONE_RE,
} from '../../common/http/rules';

export class LoginDto {
  @IsString() @MaxLength(190) identifier!: string;
  @IsString() @MaxLength(CURRENT_PASSWORD_MAX) password!: string;
  @IsOptional() @IsString() @MaxLength(60) device?: string;
}

export class RegisterDto {
  @IsString() @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(160) email!: string;
  @IsOptional() @IsString() @MaxLength(20) @Matches(PHONE_RE) phone?: string;
  // security: not in legacy: the new-password policy (rules.ts).
  @IsString()
  @MinLength(PASSWORD_MIN, {
    message: `The password field must be at least ${PASSWORD_MIN} characters.`,
  })
  @MaxLength(PASSWORD_MAX)
  @Matches(PASSWORD_RE, {
    message:
      'The password must contain an uppercase letter, a lowercase letter, a digit and a symbol.',
  })
  password!: string;
  @IsString() @MaxLength(PASSWORD_MAX) password_confirmation!: string;
  @IsIn([Role.Student, Role.Teacher, Role.Parent]) role!: Role;
  @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @IsOptional() @IsString() @MaxLength(20) school_code?: string;
}

export class SendOtpDto {
  @IsString() @MaxLength(20) @Matches(PHONE_RE) phone!: string;
}

export class VerifyOtpDto {
  @IsString() @MaxLength(20) @Matches(PHONE_RE) phone!: string;
  @IsString() @MinLength(4) @MaxLength(10) otp!: string;
  @IsOptional() @IsString() @MaxLength(60) device?: string;
}
