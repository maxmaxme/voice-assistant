export interface NormalizedAudioFile {
  contentType: string;
  extension: string;
}

export function parseContentType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(';', 1)[0]?.trim().toLowerCase() || 'audio/wav';
}

export function normalizeAudioFile(contentType: string): NormalizedAudioFile {
  switch (contentType) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return { contentType: 'audio/mpeg', extension: 'mp3' };
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return { contentType: 'audio/mp4', extension: 'm4a' };
    case 'audio/ogg':
    case 'application/ogg':
      return { contentType: 'audio/ogg', extension: 'ogg' };
    case 'audio/webm':
      return { contentType: 'audio/webm', extension: 'webm' };
    case 'audio/flac':
      return { contentType: 'audio/flac', extension: 'flac' };
    case 'audio/wave':
    case 'audio/x-wav':
    case 'audio/wav':
    default:
      return { contentType: 'audio/wav', extension: 'wav' };
  }
}
