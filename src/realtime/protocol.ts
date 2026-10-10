import { z } from 'zod';

/** Device-chosen turn id (proto 2). Opaque to the bridge: it echoes the id of
 *  the turn a turn-scoped server message (`phase` / `follow_up` / `error`)
 *  belongs to, so the device can drop late messages from a turn it already
 *  aborted locally (a Stop, a cancel, a watchdog) — the device is
 *  authoritative for its own aborts and never waits for the bridge to agree.
 *  Optional: proto-1 firmware sends none, and the bridge then stamps nothing. */
const TurnIdSchema = z.number().int().nonnegative();

export const DeviceMessageSchema = z.discriminatedUnion('type', [
  // Sent by the device when the wake word fires — a turn is beginning. The
  // bridge flips to the `listening` phase on receipt so it doesn't lag until
  // OpenAI's server-VAD speech_started. This is the only "open a turn" signal,
  // barge-in included: on `start` the bridge also cancels any reply still in
  // flight, so the device does NOT send a separate `interrupt` to barge in.
  // `turn` (proto 2): the id the device assigned this turn — see TurnIdSchema.
  z.object({ type: z.literal('start'), turn: TurnIdSchema.optional() }),
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
export const PROTO_VERSION = 2;

// `turn` on the turn-scoped messages (phase / error / follow_up): the device
// turn id from the `start` that opened the bridge's current turn, omitted
// until the device has sent one. Stamped centrally by the bridge's send path.
export type ServerMessage =
  | { type: 'phase'; value: Phase; turn?: number }
  | { type: 'error'; message: string; turn?: number }
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
  | { type: 'follow_up'; ms: number; chime?: boolean; turn?: number };

export function parseDeviceMessage(raw: string): DeviceMessage {
  const json = JSON.parse(raw);
  return DeviceMessageSchema.parse(json);
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
