import { Hono, type Context } from 'hono';
import { RoomError } from '../core/errors.ts';
import {
  httpCommands,
  iso,
  messageJson,
  messagesText,
  roomText,
  seatedText,
  transcriptMarkdown,
  wrapBrief,
  inviteText,
  reconnectInviteText,
} from '../core/format.ts';
import {
  claimSeat,
  describeInvite,
  describeReconnect,
  fullTranscript,
  leaveSeat,
  postMessage,
  readMessages,
  redeemReconnect,
  roster,
  seatByPass,
  waitForMessages,
  watchUrl,
  type RoomView,
  type SeatContext,
} from '../core/rooms.ts';
import { config } from '../config.ts';
import { claimPage, reconnectPage, notFoundPage } from '../web/pages.ts';
import { roomStream } from './stream.ts';

export const wantsJson = (c: Context) =>
  c.req.query('format') === 'json' || (c.req.header('accept') ?? '').includes('application/json');

const prefersHtml = (c: Context) => (c.req.header('accept') ?? '').includes('text/html');

function bearer(c: Context): string {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  return match?.[1] ?? '';
}

function afterParam(c: Context): number {
  const raw = c.req.query('after') ?? '0';
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) throw new RoomError('invalid', 'after must be a message id, or 0 for the start.');
  return after;
}

async function bodyField(c: Context, field: string): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = await c.req.json().catch(() => null);
    return body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  }
  if (type.includes('multipart/form-data')) return (await c.req.parseBody())[field];
  return undefined;
}

const roomJson = (room: RoomView) => ({
  title: room.title,
  owner: room.ownerName,
  expiresAt: iso(room.expiresAt),
  guestSeats: room.guestSeatLimit,
});

async function seatedResponse(c: Context, s: SeatContext & { pass: string; watchCode?: string }, reconnected = false) {
  const list = await roster(s.room.id);
  const watch = s.watchCode ? watchUrl(s.watchCode) : undefined;
  if (wantsJson(c)) {
    return c.json({
      pass: s.pass,
      watchUrl: watch,
      seat: { name: s.seat.displayName, role: s.seat.role },
      room: roomJson(s.room),
      roster: list,
      brief: wrapBrief(s.room),
    });
  }
  return c.text(seatedText('http', { room: s.room, seat: s.seat, pass: s.pass, watchUrl: watch, roster: list, reconnected }));
}

/** Claim links and one-time seat links. GET describes, POST claims. */
export const links = new Hono();

links.get('/j/:code', async (c) => {
  const code = c.req.param('code');
  const link = `${config.publicUrl}/j/${code}`;
  try {
    const info = await describeInvite(code);
    return prefersHtml(c) ? c.html(claimPage(info, link)) : c.text(inviteText(info, link));
  } catch (error) {
    if (error instanceof RoomError && prefersHtml(c)) return c.html(notFoundPage(error.message), error.status);
    throw error;
  }
});

links.post('/j/:code', async (c) => {
  // Accept a JSON or form body; a bare text body is taken as the name.
  let name = await bodyField(c, 'name');
  if (name === undefined) {
    const raw = (await c.req.text()).trim();
    name = new URLSearchParams(raw).get('name') ?? raw;
  }
  const claimed = await claimSeat(c.req.param('code'), name);
  return seatedResponse(c, claimed);
});

links.get('/r/:code', async (c) => {
  const code = c.req.param('code');
  const link = `${config.publicUrl}/r/${code}`;
  try {
    const found = await describeReconnect(code);
    return prefersHtml(c) ? c.html(reconnectPage(found, link)) : c.text(reconnectInviteText(found, link));
  } catch (error) {
    if (error instanceof RoomError && prefersHtml(c)) return c.html(notFoundPage(error.message), error.status);
    throw error;
  }
});

links.post('/r/:code', async (c) => seatedResponse(c, await redeemReconnect(c.req.param('code')), true));

/** The seat API. The pass travels in the Authorization header, never in the path. */
export const api = new Hono();

api.get('/room', async (c) => {
  const ctx = await seatByPass(bearer(c));
  const list = await roster(ctx.room.id);
  if (wantsJson(c)) {
    return c.json({ room: roomJson(ctx.room), you: { name: ctx.seat.displayName, role: ctx.seat.role }, roster: list, brief: wrapBrief(ctx.room) });
  }
  return c.text(roomText(ctx.room, ctx.seat, list));
});

api.post('/send', async (c) => {
  const ctx = await seatByPass(bearer(c));
  let text = await bodyField(c, 'text');
  if (text === undefined) text = await c.req.text();
  const m = await postMessage(ctx, text);
  return wantsJson(c) ? c.json({ id: m.id, at: iso(m.at) }) : c.text(`Sent as message ${m.id}.`);
});

api.get('/wait', async (c) => {
  const after = afterParam(c);
  const seconds = Math.min(Math.max(Number(c.req.query('timeout') ?? 45) || 45, 1), config.waitMs / 1000);
  const { ctx, messages } = await waitForMessages(bearer(c), after, seconds * 1000, c.req.raw.signal);
  if (wantsJson(c)) {
    return c.json({
      messages: messages.map((m) => messageJson(m, ctx.seat.id)),
      lastId: messages.at(-1)?.id ?? after,
      again: messages.length === 0,
    });
  }
  return c.text(messagesText(messages, after, ctx.seat.id, true));
});

api.get('/read', async (c) => {
  const after = afterParam(c);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 500);
  const ctx = await seatByPass(bearer(c));
  const messages = await readMessages(ctx.room.id, after, { limit });
  if (wantsJson(c)) {
    return c.json({
      messages: messages.map((m) => messageJson(m, ctx.seat.id)),
      lastId: messages.at(-1)?.id ?? after,
      more: messages.length === limit,
    });
  }
  const more = messages.length === limit ? `\nMore remain. Call read with after=${messages.at(-1)!.id}.` : '';
  return c.text(messagesText(messages, after, ctx.seat.id, false) + more);
});

api.post('/leave', async (c) => {
  await leaveSeat(await seatByPass(bearer(c)));
  return wantsJson(c) ? c.json({ left: true }) : c.text('You left the room. Your seat pass no longer works.');
});

api.get('/transcript', async (c) => {
  const ctx = await seatByPass(bearer(c));
  return c.text(transcriptMarkdown(ctx.room, await fullTranscript(ctx.room.id)), 200, {
    'content-type': 'text/markdown; charset=utf-8',
  });
});

api.get('/stream', async (c) => {
  const pass = bearer(c);
  const ctx = await seatByPass(pass);
  return roomStream(c, {
    roomId: ctx.room.id,
    after: afterParam(c),
    check: async () => (await seatByPass(pass)).room,
    render: (m) => messageJson(m, ctx.seat.id),
    roster: () => roster(ctx.room.id),
  });
});

api.get('/', (c) => c.text(`agcontextlink seat API. Join a room by opening its link.\n\n${httpCommands('YOUR_PASS')}`));
