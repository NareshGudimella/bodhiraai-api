import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../common/roles';

export class LoginDto {
  @IsString() identifier!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() @MaxLength(60) device?: string;
}

export class RegisterDto {
  @IsString() @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(160) email!: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsString() @MinLength(6) password!: string;
  @IsString() password_confirmation!: string;
  @IsIn([Role.Student, Role.Teacher, Role.Parent]) role!: Role;
  @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @IsOptional() @IsString() school_code?: string;
}

export class SendOtpDto {
  @IsString() @MaxLength(20) phone!: string;
}

export class VerifyOtpDto {
  @IsString() @MaxLength(20) phone!: string;
  @IsString() @MinLength(4) @MaxLength(10) otp!: string;
  @IsOptional() @IsString() @MaxLength(60) device?: string;
}
