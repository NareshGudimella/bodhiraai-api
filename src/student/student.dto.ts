import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
} from 'class-validator';

/** Laravel `integer` accepts numeric strings. */
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;

/** Laravel `boolean` accepts true/false/1/0/"1"/"0". */
const toBool = ({ value }: { value: unknown }) => {
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return value;
};

export class ProgressDto {
  @Transform(toInt) @IsInt() @Min(0) @Max(864000) watched_seconds!: number;
  @IsOptional() @Transform(toBool) @IsBoolean() completed?: boolean | null;
}

export class AnswerDto {
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  question_id!: number;
  // security: not in legacy: at most 50 answers, each a string of up to 1000 characters.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  answer!: unknown[];
}
