import type { Response } from 'express';
import { rawDateTime } from '../common/http/laravel';

type Cell = string | number | bigint | Date | null | undefined;

/** PHP fputcsv(): quote a field holding a delimiter, quote, space, tab, newline or backslash. */
function field(v: Cell): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? (rawDateTime(v) ?? '') : String(v);
  return /[,"\s\\]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** response()->streamDownload of fputcsv rows (LeadController::csv). */
export function sendCsv(
  res: Response,
  filename: string,
  headers: string[],
  rows: Cell[][],
) {
  const body = [headers, ...rows]
    .map((r) => r.map(field).join(',') + '\n')
    .join('');
  res
    .status(200)
    .type('text/csv; charset=utf-8')
    .attachment(filename)
    .send(body);
}
