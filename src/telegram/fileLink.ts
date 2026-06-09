import { Api } from 'grammy';

/** Resolves a Telegram file_id into a direct download URL.
 *  Replaces telegraf's `Telegram.getFileLink`; tests inject a fake `api`. */
export interface TelegramFileLinkResolver {
  getFileLink(fileId: string): Promise<string>;
}

type GetFileApi = Pick<Api, 'getFile'>;

export function fileLinkResolver(botToken: string, api?: GetFileApi): TelegramFileLinkResolver {
  const client: GetFileApi = api ?? new Api(botToken);
  return {
    async getFileLink(fileId: string): Promise<string> {
      const file = await client.getFile(fileId);
      if (!file.file_path) {
        throw new Error(`Telegram getFile(${fileId}) returned no file_path`);
      }
      return `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    },
  };
}
