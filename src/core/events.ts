import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from '../config.ts';

export type RoomEvent = 'message' | 'seat' | 'room' | 'end';
export const CHANNEL = 'agcontextlink';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let client: pg.Client | undefined;
let stopped = false;

/** One LISTEN connection per process wakes every waiting agent and live page in it. */
export async function startListening(): Promise<void> {
  stopped = false;
  const next = new pg.Client({ connectionString: config.databaseUrl });
  next.on('notification', (n) => {
    if (!n.payload) return;
    try {
      const { room, kind } = JSON.parse(n.payload) as { room: string; kind: RoomEvent };
      emitter.emit(room, kind);
    } catch {
      // Ignore payloads we did not send.
    }
  });
  next.on('error', () => {
    next.end().catch(() => {});
    if (client === next) client = undefined;
    if (!stopped) setTimeout(() => startListening().catch(() => {}), 1000);
  });
  await next.connect();
  await next.query(`LISTEN ${CHANNEL}`);
  client = next;
}

export async function stopListening(): Promise<void> {
  stopped = true;
  await client?.end().catch(() => {});
  client = undefined;
}

export function onRoom(roomId: string, listener: (kind: RoomEvent) => void): () => void {
  emitter.on(roomId, listener);
  return () => emitter.off(roomId, listener);
}
