import { Hono, type Context } from 'hono';
import { currentOwner, devSignIn, providers, signOut, startSocialSignIn, type Owner } from '../auth.ts';
import { config } from '../config.ts';
import { RoomError } from '../core/errors.ts';
import { iso, transcriptMarkdown } from '../core/format.ts';
import {
  createRoom,
  endRoom,
  extendRoom,
  fullTranscript,
  issueReconnect,
  leaveSeat,
  listLiveRooms,
  mintDirectLink,
  ownedRoom,
  ownerSeatLink,
  removeSeat,
  reopenSeat,
  revokeInvite,
  roomDetail,
  roster,
  seatByWatch,
  type MessageView,
  type RoomView,
} from '../core/rooms.ts';
import { roomStream } from '../api/stream.ts';
import { dashboardPage, notFoundPage, roomPage, seatsFragment, signInPage, watchPage } from './pages.ts';

type Env = { Variables: { owner: Owner } };

export const web = new Hono<Env>();

const pageMessage = (m: MessageView) => ({ id: m.id, from: m.from, role: m.role, at: iso(m.at), text: m.text });

function download(c: Context, room: RoomView, list: MessageView[]) {
  const name = room.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'room';
  return c.body(transcriptMarkdown(room, list), 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="transcript.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`,
  });
}

/** Cookie-backed forms only accept posts from this site. */
web.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(config.publicUrl).origin) return c.text('Cross-site request refused.', 403);
  }
  await next();
});

web.get('/', async (c) => {
  const owner = await currentOwner(c);
  if (!owner) return c.html(signInPage({ providers, devLogin: config.devLogin, error: c.req.query('error') }));
  return c.html(dashboardPage(owner, await listLiveRooms(owner.id), c.req.query('error')));
});

web.post('/signin/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (provider === 'dev' && config.devLogin) return devSignIn(c);
  if (provider === 'github' || provider === 'google') {
    if (providers.includes(provider)) return startSocialSignIn(c, provider);
  }
  return c.redirect('/');
});

web.post('/signout', (c) => signOut(c));

// Watch pages: a guest's human follows the room. The watch code in the path can read and manage its own seat.

web.get('/w/:code', async (c) => {
  try {
    const ctx = await seatByWatch(c.req.param('code'));
    return c.html(watchPage(ctx, c.req.param('code'), await roster(ctx.room.id)));
  } catch (error) {
    if (error instanceof RoomError) return c.html(notFoundPage(error.message), error.status);
    throw error;
  }
});

web.get('/w/:code/stream', async (c) => {
  const code = c.req.param('code');
  const ctx = await seatByWatch(code);
  return roomStream(c, {
    roomId: ctx.room.id,
    after: 0,
    check: async () => (await seatByWatch(code)).room,
    render: pageMessage,
    roster: () => roster(ctx.room.id),
  });
});

web.get('/w/:code/transcript', async (c) => {
  const ctx = await seatByWatch(c.req.param('code'));
  return download(c, ctx.room, await fullTranscript(ctx.room.id));
});

web.post('/w/:code/reconnect', async (c) => {
  const code = c.req.param('code');
  const ctx = await seatByWatch(code);
  const link = await issueReconnect(ctx.seat.id);
  return c.html(watchPage(ctx, code, await roster(ctx.room.id), link));
});

web.post('/w/:code/leave', async (c) => {
  const ctx = await seatByWatch(c.req.param('code'));
  await leaveSeat(ctx);
  return c.html(notFoundPage('Your agent left the room.'));
});

// Owner pages

const owned = new Hono<Env>();

owned.use('*', async (c, next) => {
  const owner = await currentOwner(c);
  if (!owner) return c.redirect('/');
  c.set('owner', owner);
  await next();
});

const back = (c: Context<Env>, error?: string) => {
  const target = `/rooms/${c.req.param('id')}`;
  return c.redirect(error ? `${target}?error=${encodeURIComponent(error)}` : target, 303);
};

/** Runs an owner action and returns to the room page, carrying a RoomError message along. */
const action = (run: (c: Context<Env>, form: Record<string, unknown>) => Promise<unknown>) => async (c: Context<Env>) => {
  try {
    await run(c, await c.req.parseBody());
    return back(c);
  } catch (error) {
    if (error instanceof RoomError) return back(c, error.message);
    throw error;
  }
};

owned.post('/', async (c) => {
  const form = await c.req.parseBody();
  try {
    const room = await createRoom(c.var.owner, {
      title: form.title,
      brief: form.brief,
      guestSeats: form.guestSeats,
      lifetimeMinutes: form.lifetimeMinutes,
    });
    return c.redirect(`/rooms/${room.id}`, 303);
  } catch (error) {
    if (error instanceof RoomError) return c.redirect(`/?error=${encodeURIComponent(error.message)}`, 303);
    throw error;
  }
});

owned.get('/:id', async (c) => {
  try {
    return c.html(roomPage(c.var.owner, await roomDetail(c.var.owner.id, c.req.param('id')), { error: c.req.query('error') }));
  } catch (error) {
    if (error instanceof RoomError) return c.redirect('/');
    throw error;
  }
});

owned.get('/:id/seats', async (c) => c.html(seatsFragment(await roomDetail(c.var.owner.id, c.req.param('id')))));

owned.get('/:id/stream', async (c) => {
  const { id: ownerId } = c.var.owner;
  const room = await ownedRoom(ownerId, c.req.param('id'));
  return roomStream(c, {
    roomId: room.id,
    after: 0,
    check: () => ownedRoom(ownerId, room.id),
    render: pageMessage,
    roster: () => roster(room.id),
  });
});

owned.get('/:id/transcript', async (c) => {
  const room = await ownedRoom(c.var.owner.id, c.req.param('id'));
  return download(c, room, await fullTranscript(room.id));
});

owned.post('/:id/owner-seat', async (c) => {
  try {
    const link = await ownerSeatLink(c.var.owner.id, c.req.param('id'));
    return c.html(roomPage(c.var.owner, await roomDetail(c.var.owner.id, c.req.param('id')), { ownerLink: link }));
  } catch (error) {
    if (error instanceof RoomError) return back(c, error.message);
    throw error;
  }
});

owned.post('/:id/links', action((c, form) => mintDirectLink(c.var.owner.id, c.req.param('id')!, form.label)));
owned.post('/:id/links/:invite/revoke', action((c) => revokeInvite(c.var.owner.id, c.req.param('id')!, c.req.param('invite')!)));
owned.post('/:id/seats/:seat/remove', action((c) => removeSeat(c.var.owner.id, c.req.param('id')!, c.req.param('seat')!)));
owned.post('/:id/seats/:seat/reopen', action((c) => reopenSeat(c.var.owner.id, c.req.param('id')!, c.req.param('seat')!)));
owned.post('/:id/extend', action((c, form) => extendRoom(c.var.owner.id, c.req.param('id')!, form.minutes)));

owned.post('/:id/end', async (c) => {
  try {
    await endRoom(c.var.owner.id, c.req.param('id'));
  } catch (error) {
    if (!(error instanceof RoomError)) throw error;
  }
  return c.redirect('/', 303);
});

web.route('/rooms', owned);
