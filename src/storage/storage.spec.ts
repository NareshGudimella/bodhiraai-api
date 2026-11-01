import { strSlug } from './laravel-str';
import { checkUpload, sniff, UploadRejected } from './upload-rules';

describe('Str::slug port (expected values from Laravel)', () => {
  it.each([
    ['Priya Patel', 'priya-patel'],
    ['José Ñúñez', 'jose-nunez'],
    ['a_b@c.d', 'a-b-at-cd'],
    ["  Mr.  O'Brien--Jr ", 'mr-obrien-jr'],
    ['Rahul (2nd)', 'rahul-2nd'],
  ])('%s → %s', (title, slug) => expect(strSlug(title)).toBe(slug));
});

const file = (name: string, bytes: Buffer | string, size?: number) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { originalname: name, buffer, size: size ?? buffer.length };
};
const PDF = '%PDF-1.4\n%%EOF';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('upload rules (FileUploadService::validate)', () => {
  it('sniffs content, not the client-supplied type', () => {
    expect(sniff(Buffer.from(PDF))).toBe('pdf');
    expect(sniff(PNG)).toBe('png');
    expect(sniff(Buffer.from('PK\x03\x04rest'))).toBe('zip');
    expect(sniff(Buffer.from([0, 1, 2, 3]))).toBe('unknown');
  });

  it('accepts allowed extension + matching content', () => {
    expect(checkUpload(file('Work.PDF', PDF), 'doc')).toEqual({
      ext: 'pdf',
      contentType: 'application/pdf',
    });
    expect(checkUpload(file('me.png', PNG), 'image').contentType).toBe(
      'image/png',
    );
  });

  it('rejects like legacy: extension, content type, size', () => {
    expect(() => checkUpload(file('x.exe', PDF), 'doc')).toThrow(
      'Extension .exe not allowed for doc.',
    );
    expect(() =>
      checkUpload(file('x.pdf', Buffer.from([0, 1, 2])), 'doc'),
    ).toThrow(
      'MIME type application/octet-stream does not match a permitted doc type.',
    );
    expect(() => checkUpload(file('x.png', PDF), 'image')).toThrow(
      UploadRejected,
    );
    expect(() =>
      checkUpload(file('big.pdf', PDF, 51 * 1024 * 1024), 'doc'),
    ).toThrow('File exceeds 50MB limit.');
  });

  it('accepts a text file named .pdf for documents, as legacy does (txt is allowed)', () => {
    expect(
      checkUpload(file('notes.pdf', 'plain words'), 'doc').contentType,
    ).toBe('text/plain; charset=utf-8');
  });
});
