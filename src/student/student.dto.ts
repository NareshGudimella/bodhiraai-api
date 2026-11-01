import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
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
  @Transform(toInt) @IsInt() @Min(0) watched_seconds!: number;
  @IsOptional() @Transform(toBool) @IsBoolean() completed?: boolean | null;
}

export class AnswerDto {
  @Transform(toInt) @IsInt() question_id!: number;
  @IsArray() @ArrayNotEmpty() answer!: unknown[];
}
