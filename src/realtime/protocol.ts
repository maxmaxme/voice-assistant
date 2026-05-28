import { z } from 'zod';

export const DeviceMessageSchema = z.discriminatedUnion('type', [
  // Sent by the device when the wake word fires — a turn is beginning. The
  // bridge flips to the `listening` phase on receipt so it doesn't lag until
  // OpenAI's server-VAD speech_started. This is the only "open a turn" signal,
  // barge-in included: on `start` the bridge also cancels any reply still in
  // flight, so the device does NOT send a separate `interrupt` to barge in.
  z.object({ type: z.literal('start') }),
  // Sent when the device aborts the current turn and returns to idle — a Stop
  // wake word or the no-speech watchdog. The bridge cancels the response and
  // moves its phase back to idle (re-arming the idle-reset). NOT used for
  // barge-in (that's `start`).
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
