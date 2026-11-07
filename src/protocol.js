import { randomUUID } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 2;

export const MSG_TYPES = Object.freeze({
  HELLO: "hello",
  DEVICE_READY: "device_ready",
  PAIRING_REQUIRED: "pairing_required",
  PAIRED: "paired",
  HEARTBEAT: "heartbeat",
  ATTACH_REQUEST: "attach_request",
  ATTACH_RESPONSE: "attach_response",
  ACTION_REQUEST: "action_request",
  ACTION_CHUNK: "action_chunk",
  ACTION_RESULT: "action_result",
  REVOKED: "revoked",
  ERROR: "error"
});

const BaseEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.enum(Object.values(MSG_TYPES)),
  payload: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.number().int().nonnegative()
});

export function makeMessage(type, payload = {}, id = randomUUID()) {
  if (!Object.values(MSG_TYPES).includes(type)) {
    throw new Error(`Unknown protocol message type: ${type}`);
  }

  return JSON.stringify({
    version: PROTOCOL_VERSION,
    id,
    type,
    payload,
    timestamp: Date.now()
  });
}

export function parseMessage(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString("utf8"));
    const result = BaseEnvelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
