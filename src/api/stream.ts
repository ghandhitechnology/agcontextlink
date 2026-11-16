import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { RoomError } from '../core/errors.ts';
import { onRoom } from '../core/events.ts';
import { readMessages, untilRoomEvent, type MessageView } from '../core/rooms.ts';

interface RoomStreamOptions {
  roomId: string;
  after: number;
  /** Re-checks access on every wake. Throwing a RoomError ends the stream with its message. */
  check: () => Promise<{ expiresAt: Date }>;
  render: (m: MessageView) => unknown;
  roster?: () => Promise<unknown>;
}

/** Server-sent events: the backlog after `after`, then each new message, roster changes and the end. */
export function roomStream(c: Context, options: RoomStreamOptions): Response {
  const resumeFrom = Number(c.req.header('last-event-id'));
  let after = Number.isSafeInteger(resumeFrom) && resumeFrom > 0 ? resumeFrom : options.after;

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    let rosterDirty = Boolean(options.roster);
    const off = onRoom(options.roomId, (kind) => {
      if (kind !== 'message') rosterDirty = Boolean(options.roster);
    });
    try {
      while (!abort.signal.aborted) {
        if (rosterDirty && options.roster) {
          rosterDirty = false;
          await stream.writeSSE({ event: 'roster', data: JSON.stringify(await options.roster()) });
        }
        const list = await untilRoomEvent(options.roomId, {
          deadline: Date.now() + 20_000,
          signal: abort.signal,
          check: options.check,
          poll: async () => {
            if (rosterDirty) return [];
            const found = await readMessages(options.roomId, after, { limit: 200 });
            return found.length ? found : undefined;
          },
        });
        if (list === undefined) {
          await stream.write(': ping\n\n');
          continue;
        }
        for (const m of list) {
          await stream.writeSSE({ event: 'message', id: String(m.id), data: JSON.stringify(options.render(m)) });
          after = m.id;
        }
      }
    } catch (error) {
      if (!(error instanceof RoomError)) throw error;
      await stream.writeSSE({ event: 'end', data: error.message });
    } finally {
      off();
    }
  });
}
