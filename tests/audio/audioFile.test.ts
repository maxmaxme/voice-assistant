import { describe, it, expect } from 'vitest';
import { normalizeAudioFile, parseContentType } from '../../src/audio/audioFile.ts';

describe('audioFile utilities', () => {
  describe('parseContentType', () => {
    it('normalizes header content type values', () => {
      expect(parseContentType('Audio/X-M4A; charset=binary')).toBe('audio/x-m4a');
      expect(parseContentType([' audio/ogg ; codecs=opus', 'audio/wav'])).toBe('audio/ogg');
    });

    it('defaults missing content type to wav', () => {
      expect(parseContentType(undefined)).toBe('audio/wav');
      expect(parseContentType('')).toBe('audio/wav');
    });
  });

  describe('normalizeAudioFile', () => {
    it('maps common audio content types to OpenAI-friendly file metadata', () => {
      expect(normalizeAudioFile('audio/x-m4a')).toEqual({
        contentType: 'audio/mp4',
        extension: 'm4a',
      });
      expect(normalizeAudioFile('audio/mpeg')).toEqual({
        contentType: 'audio/mpeg',
        extension: 'mp3',
      });
      expect(normalizeAudioFile('application/ogg')).toEqual({
        contentType: 'audio/ogg',
        extension: 'ogg',
      });
      expect(normalizeAudioFile('audio/x-wav')).toEqual({
        contentType: 'audio/wav',
        extension: 'wav',
      });
    });

    it('defaults unknown content types to wav metadata', () => {
      expect(normalizeAudioFile('application/octet-stream')).toEqual({
        contentType: 'audio/wav',
        extension: 'wav',
      });
    });
  });
});
