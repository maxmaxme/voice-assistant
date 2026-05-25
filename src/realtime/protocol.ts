import { z } from 'zod';

export const DeviceMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('ping') }),
]);

export type DeviceMessage = z.infer<typeof DeviceMessageSchema>;

export type Phase = 'idle' | 'listening' | 'thinking' | 'replying';

export type ServerMessage =
  | { type: 'phase'; value: Phase }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'hello'; audioOut: 'pcm' | 'opus' }
  // Model explicitly requested that the user be allowed to answer without
  // a new wake word — open the follow-up mic window on the device.
  | { type: 'request_follow_up' };

export function parseDeviceMessage(raw: string): DeviceMessage {
  const json = JSON.parse(raw);
  return DeviceMessageSchema.parse(json);
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
