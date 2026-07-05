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

/** Wire-protocol version, carried in `hello`. The firmware reads it tolerantly
 *  (`doc["proto"] | 0`) and logs a loud warning on mismatch instead of
 *  disconnecting — the point is to make server↔firmware drift visible in both
 *  logs, not to brick a stale speaker. Bump on any breaking change to the
 *  message shapes below, in lockstep with va_client (home-assistant-voice-pe). */
export const PROTO_VERSION = 1;

export type ServerMessage =
  | { type: 'phase'; value: Phase }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  // Handshake ack, sent once on connect. `wakeChime` pushes the admin's
  // wake-beep preference to the device (which has no other control surface —
  // no HA API, no web server), so the local wake-word sound is gated by it.
  | { type: 'hello'; proto: number; audioOut: 'pcm' | 'opus'; wakeChime: boolean }
  // Reopen the mic after a SPOKEN reply so the user can answer without a wake
  // word. Sent right before the end-of-turn `idle`; the device latches it and
  // opens the window once the reply drains. `ms` = window length (from realtime
  // config; 0 there → this message is never sent). `chime` (default false):
  // play the "your turn" chime and use the chimed open UX — set when the model
  // explicitly asked a question (request_follow_up tool) and only if the admin
  // enabled the chime; the ambient after-every-reply window is silent. A
  // silent wait_for_user, a barge-in interrupt, or the initial idle send no
  // follow_up at all. The server owns this decision, not the device.
  | { type: 'follow_up'; ms: number; chime?: boolean };

export function parseDeviceMessage(raw: string): DeviceMessage {
  const json = JSON.parse(raw);
  return DeviceMessageSchema.parse(json);
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
