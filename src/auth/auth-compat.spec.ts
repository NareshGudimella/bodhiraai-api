import { detectField } from './auth.service';
import { hashPassword, verifyPassword } from './password';

describe('detectField (port of Web\\AuthController::detectField)', () => {
  it.each([
    ['student@bodhira.test', 'email'],
    ['+91 90000 11111', 'phone'],
    ['(040) 123-4567', 'phone'],
    ['12345', 'username'],
    ['rahul.v', 'username'],
  ])('%s → %s', (input, field) => {
    expect(detectField(input)).toBe(field);
  });
});

describe('bcrypt compatibility with Laravel', () => {
  // Generated with PHP: password_hash("secret-123", PASSWORD_BCRYPT)
  const phpHash =
    '$2y$12$S6LMMTrqrv4JiG35QVaNveHjXFpH3YYDxZQ2gi/jCDVMjlVvD89ii';

  it('verifies a hash created by PHP', async () => {
    await expect(verifyPassword('secret-123', phpHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong', phpHash)).resolves.toBe(false);
  });

  it('writes $2y$ hashes that PHP can verify', async () => {
    const hash = await hashPassword('secret-123');
    expect(hash).toMatch(/^\$2y\$12\$/);
    await expect(verifyPassword('secret-123', hash)).resolves.toBe(true);
  });

  it('rejects users without a password', async () => {
    await expect(verifyPassword('x', null)).resolves.toBe(false);
  });
});
