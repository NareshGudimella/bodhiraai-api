import bcrypt from 'bcryptjs';

/** Laravel hashes with PHP's `$2y$` bcrypt prefix; keep it so both apps verify each other's hashes. */
export async function hashPassword(plain: string): Promise<string> {
  const hash = await bcrypt.hash(plain, 12);
  return hash.replace(/^\$2[ab]\$/, '$2y$');
}

export function verifyPassword(
  plain: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash.replace(/^\$2y\$/, '$2b$'));
}
