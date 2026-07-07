import { describe, it, expect } from 'vitest';
import { extractYoutubeVideoId } from './youtube-fetch.js';

/** v1048 — pure Helfer der geteilten YouTube-Bausteine (Skill + Topic-Collector). */
describe('extractYoutubeVideoId (v1048)', () => {
  it('erkennt gängige URL-Formate und nackte 11-Zeichen-IDs', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('Kanal-URLs, leere und kaputte Eingaben → null', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/@ServusTVSport')).toBeNull();
    expect(extractYoutubeVideoId('')).toBeNull();
    expect(extractYoutubeVideoId(undefined)).toBeNull();
    expect(extractYoutubeVideoId('zu-kurz')).toBeNull();
  });
});
