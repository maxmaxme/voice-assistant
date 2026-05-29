export const HOUSEHOLD_OWNER = 'household';

export function personalOwner(userId: number): string {
  return `user:${userId}`;
}
