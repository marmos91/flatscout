import { describe, expect, it } from 'vitest';
import { extractOgImage } from '../src/photos.js';

describe('extractOgImage', () => {
  it('returns absolute URL when meta tag is relative', () => {
    const html =
      '<head><meta property="og:image" content="/thumb/ff/2025/02/ajnwlfqvk0kn08rh9b48qye2zo5els9f58qojc1q81g7lxtunx.jpg?alias=facebook_l&amp;signature=abcXYZ" /></head>';
    expect(extractOgImage(html)).toBe(
      'https://flatfox.ch/thumb/ff/2025/02/ajnwlfqvk0kn08rh9b48qye2zo5els9f58qojc1q81g7lxtunx.jpg?alias=facebook_l&signature=abcXYZ',
    );
  });

  it('returns absolute URL unchanged when meta tag already absolute', () => {
    const html = '<meta property="og:image" content="https://cdn.x/img.jpg" />';
    expect(extractOgImage(html)).toBe('https://cdn.x/img.jpg');
  });

  it('returns null when meta tag absent', () => {
    expect(extractOgImage('<html></html>')).toBeNull();
  });

  it('returns null for a non-URL relative path', () => {
    expect(extractOgImage('<meta property="og:image" content="not-a-path" />')).toBeNull();
  });
});
