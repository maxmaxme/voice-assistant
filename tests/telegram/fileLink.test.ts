import { describe, it, expect, vi } from 'vitest';
import { fileLinkResolver } from '../../src/telegram/fileLink.ts';

describe('fileLinkResolver', () => {
  it('builds a download URL from getFile().file_path', async () => {
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_42.oga' }) };
    const resolver = fileLinkResolver('TOKEN', api);
    await expect(resolver.getFileLink('abc')).resolves.toBe(
      'https://api.telegram.org/file/botTOKEN/voice/file_42.oga',
    );
    expect(api.getFile).toHaveBeenCalledWith('abc');
  });

  it('throws when file_path is missing', async () => {
    const api = { getFile: vi.fn().mockResolvedValue({}) };
    const resolver = fileLinkResolver('TOKEN', api);
    await expect(resolver.getFileLink('abc')).rejects.toThrow(/file_path/);
  });
});
