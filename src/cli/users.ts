import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { openMemoryStore } from '../memory/memoryStore.ts';
import { hashToken } from '../memory/identities.ts';
import type { IdentitiesAdapter } from '../memory/types.ts';

export interface UsersCommandResult {
  userId?: number;
  token?: string;
  message?: string;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Pure command core — operates on an IdentitiesAdapter so it is testable
 *  against an in-memory db. */
export function runUsersCommand(identities: IdentitiesAdapter, args: string[]): UsersCommandResult {
  const cmd = args[0];
  switch (cmd) {
    case 'add-user': {
      const name = flag(args, 'name');
      if (!name) {
        throw new Error('add-user requires --name');
      }
      const userId = identities.addUser(name);
      return { userId, message: `created user ${userId} (${name})` };
    }
    case 'attach-telegram': {
      const userId = Number(flag(args, 'user'));
      const chat = flag(args, 'chat');
      if (!Number.isFinite(userId) || !chat) {
        throw new Error('attach-telegram requires --user and --chat');
      }
      identities.attachIdentity('telegram', chat, userId);
      return { userId, message: `attached telegram chat ${chat} to user ${userId}` };
    }
    case 'mint-http': {
      const userId = Number(flag(args, 'user'));
      if (!Number.isFinite(userId)) {
        throw new Error('mint-http requires --user');
      }
      const token = randomBytes(24).toString('hex');
      identities.attachIdentity('http', hashToken(token), userId);
      return { userId, token, message: `minted http token for user ${userId}` };
    }
    case 'attach-voice': {
      const userId = Number(flag(args, 'user'));
      const token = flag(args, 'token');
      if (!Number.isFinite(userId) || !token) {
        throw new Error('attach-voice requires --user and --token');
      }
      identities.attachIdentity('voice', hashToken(token), userId);
      return { userId, message: `attached voice device to user ${userId}` };
    }
    case 'set-admin': {
      const userId = Number(flag(args, 'user'));
      if (!Number.isFinite(userId)) {
        throw new Error('set-admin requires --user');
      }
      // Default to promoting; pass --admin false to demote.
      const isAdmin = flag(args, 'admin') !== 'false';
      identities.setAdmin(userId, isAdmin);
      return {
        userId,
        message: `user ${userId} is now ${isAdmin ? 'an admin' : 'a non-admin'}`,
      };
    }
    default:
      throw new Error(
        `unknown command "${cmd ?? ''}". Use: add-user | attach-telegram | attach-voice | mint-http | set-admin`,
      );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = openMemoryStore(config.memory.dbPath);
  try {
    const result = runUsersCommand(store.identities, process.argv.slice(2));
    if (result.message) {
      process.stdout.write(result.message + '\n');
    }
    if (result.token) {
      process.stdout.write(`\nTOKEN (shown once — store it now):\n${result.token}\n`);
    }
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
