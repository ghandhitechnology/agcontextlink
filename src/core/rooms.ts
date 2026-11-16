import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../config.ts';
import { db, type Db, type Tx } from '../db/client.ts';
import { invites, messages, rooms, seats, users, type Invite, type Room, type Seat } from '../db/schema.ts';
import { ended, RoomError } from './errors.ts';
import { CHANNEL, onRoom, type RoomEvent } from './events.ts';
import { claimCode, newSecret, SECRET_SHAPE, sha256 } from './secrets.ts';

export type Role = 'owner' | 'guest';
export type RoomView = Room & { ownerName: string };
export interface SeatContext {
  seat: Seat;
  room: RoomView;
}
export interface MessageView {
  id: number;
  seatId: string;
  from: string;
  role: Role;
  at: Date;
  text: string;
}
export interface RosterEntry {
  name: string;
  role: Role;
}

const MIN_ROOM_MS = 5 * 60_000;
const NAME = /^[\p{L}\p{N} _-]{1,32}$/u;

export const claimUrl = (inviteId: string) => `${config.publicUrl}/j/${claimCode(inviteId)}`;
export const watchUrl = (code: string) => `${config.publicUrl}/w/${code}`;
export const reconnectUrl = (code: string) => `${config.publicUrl}/r/${code}`;

function notify(ex: Db | Tx, roomId: string, kind: RoomEvent) {
  return ex.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ room: roomId, kind })})`);
}

/** Locks the room row so every change to its seat count happens one at a time. */
async function lockRoom(tx: Tx, roomId: string): Promise<{ live: boolean; guestSeatLimit: number } | undefined> {
  const { rows } = await tx.execute<{ live: boolean; guest_seat_limit: number }>(
    sql`select expires_at > now() as live, guest_seat_limit from rooms where id = ${roomId} for update`,
  );
  const row = rows[0];
  return row && { live: row.live, guestSeatLimit: row.guest_seat_limit };
}

async function guestSeatsTaken(ex: Db | Tx, roomId: string): Promise<number> {
  const { rows } = await ex.execute<{ n: number }>(
    sql`select count(*)::int as n from seats where room_id = ${roomId} and role = 'guest' and released_at is null`,
  );
  return rows[0]?.n ?? 0;
}

export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!NAME.test(name)) {
    throw new RoomError('invalid', 'A display name is 1 to 32 letters, digits, spaces, hyphens or underscores.');
  }
  return name;
}

function ownerSeatName(accountName: string): string {
  const cleaned = Array.from(
    accountName.normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, ' '),
  )
    .slice(0, 32)
    .join('')
    .trim();
  return cleaned || 'owner';
}

function cleanText(raw: unknown, field: string, max: number, required = true): string {
  const text = typeof raw === 'string' ? raw.replaceAll('\0', '').trim() : '';
  if (required && !text) throw new RoomError('invalid', `${field} is required.`);
  if (text.length > max) throw new RoomError('invalid', `${field} is limited to ${max} characters.`);
  return text;
}

// Owner side

export interface NewRoom {
  title: unknown;
  brief: unknown;
  guestSeats: unknown;
  lifetimeMinutes: unknown;
}

export async function createRoom(owner: { id: string; name: string }, input: NewRoom): Promise<Room> {
  const title = cleanText(input.title, 'Title', 120);
  const brief = cleanText(input.brief, 'Brief', 8000);
  const guestSeats = Number(input.guestSeats);
  if (!Number.isInteger(guestSeats) || guestSeats < 1 || guestSeats > config.limits.maxGuestSeats) {
    throw new RoomError('invalid', `Guest seats must be between 1 and ${config.limits.maxGuestSeats}.`);
  }
  const lifetimeMs = Number(input.lifetimeMinutes) * 60_000;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < MIN_ROOM_MS || lifetimeMs > config.limits.maxRoomMs) {
    throw new RoomError('invalid', 'That lifetime is outside what this server allows.');
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${owner.id} for update`);
    const { rows } = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from rooms where owner_id = ${owner.id} and expires_at > now()`,
    );
    if ((rows[0]?.n ?? 0) >= config.limits.maxLiveRooms) {
      throw new RoomError('forbidden', `An account can hold ${config.limits.maxLiveRooms} live rooms at once.`);
    }
    const [room] = await tx
      .insert(rooms)
      .values({
        id: randomBytes(9).toString('base64url'),
        ownerId: owner.id,
        title,
        brief,
        guestSeatLimit: guestSeats,
        expiresAt: sql`now() + ${lifetimeMs} * interval '1 millisecond'`,
      })
      .returning();
    const inviteId = randomUUID();
    await tx.insert(invites).values({ id: inviteId, roomId: room!.id, codeHash: sha256(claimCode(inviteId)) });
    await tx.insert(seats).values({ roomId: room!.id, displayName: ownerSeatName(owner.name), role: 'owner' });
    return room!;
  });
}

export async function listLiveRooms(ownerId: string) {
  const { rows } = await db.execute<{ id: string; title: string; expires_at: Date; guest_seat_limit: number; taken: number }>(sql`
    select r.id, r.title, r.expires_at, r.guest_seat_limit,
      (select count(*)::int from seats s where s.room_id = r.id and s.role = 'guest' and s.released_at is null) as taken
    from rooms r where r.owner_id = ${ownerId} and r.expires_at > now()
    order by r.created_at desc`);
  return rows.map((r) => ({ id: r.id, title: r.title, expiresAt: new Date(r.expires_at), seatLimit: r.guest_seat_limit, taken: r.taken }));
}

export async function ownedRoom(ownerId: string, roomId: string): Promise<RoomView> {
  const [row] = await db
    .select({ room: rooms, ownerName: users.name })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.ownerId))
    .where(and(eq(rooms.id, roomId), eq(rooms.ownerId, ownerId), gt(rooms.expiresAt, sql`now()`)));
  if (!row) throw new RoomError('not_found', 'No live room here.');
  return { ...row.room, ownerName: row.ownerName };
}

export interface RoomDetail {
  room: RoomView;
  taken: number;
  invites: (Invite & { url: string })[];
  seats: Seat[];
}

export async function roomDetail(ownerId: string, roomId: string): Promise<RoomDetail> {
  const room = await ownedRoom(ownerId, roomId);
  const [inviteRows, seatRows, taken] = await Promise.all([
    db.select().from(invites).where(eq(invites.roomId, roomId)).orderBy(asc(invites.createdAt)),
    db.select().from(seats).where(and(eq(seats.roomId, roomId), isNull(seats.releasedAt))).orderBy(asc(seats.claimedAt)),
    guestSeatsTaken(db, roomId),
  ]);
  return { room, taken, invites: inviteRows.map((i) => ({ ...i, url: claimUrl(i.id) })), seats: seatRows };
}

export async function mintDirectLink(ownerId: string, roomId: string, rawLabel: unknown): Promise<string> {
  await ownedRoom(ownerId, roomId);
  const label = cleanText(rawLabel, 'Label', 60, false) || null;
  const id = randomUUID();
  await db.insert(invites).values({ id, roomId, codeHash: sha256(claimCode(id)), claimsAllowed: 1, label });
  return claimUrl(id);
}

export async function revokeInvite(ownerId: string, roomId: string, inviteId: string): Promise<void> {
  await ownedRoom(ownerId, roomId);
  await db
    .update(invites)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(invites.id, inviteId), eq(invites.roomId, roomId), isNull(invites.revokedAt)));
}

export async function removeSeat(ownerId: string, roomId: string, seatId: string): Promise<void> {
  await ownedRoom(ownerId, roomId);
  await db.transaction(async (tx) => {
    const done = await tx
      .update(seats)
      .set({ removedAt: sql`now()`, reconnectHash: null, reconnectExpiresAt: null })
      .where(and(eq(seats.id, seatId), eq(seats.roomId, roomId), eq(seats.role, 'guest'), isNull(seats.removedAt)))
      .returning({ id: seats.id });
    if (done.length) await notify(tx, roomId, 'seat');
  });
}

/** Frees a removed seat for a new claim and returns its claim to the link it came from. */
export async function reopenSeat(ownerId: string, roomId: string, seatId: string): Promise<void> {
  await ownedRoom(ownerId, roomId);
  await db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const [seat] = await tx
      .update(seats)
      .set({ releasedAt: sql`now()` })
      .where(
        and(eq(seats.id, seatId), eq(seats.roomId, roomId), sql`${seats.removedAt} is not null`, isNull(seats.releasedAt)),
      )
      .returning({ inviteId: seats.inviteId });
    if (!seat) return;
    await returnClaim(tx, seat.inviteId);
    await notify(tx, roomId, 'seat');
  });
}

async function returnClaim(tx: Tx, inviteId: string | null) {
  if (!inviteId) return;
  await tx
    .update(invites)
    .set({ claimsUsed: sql`greatest(${invites.claimsUsed} - 1, 0)` })
    .where(and(eq(invites.id, inviteId), sql`${invites.claimsAllowed} is not null`));
}

export async function extendRoom(ownerId: string, roomId: string, minutes: unknown): Promise<void> {
  const ms = Number(minutes) * 60_000;
  if (!Number.isFinite(ms) || ms <= 0) throw new RoomError('invalid', 'Pick how long to extend by.');
  await ownedRoom(ownerId, roomId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update rooms set expires_at = least(
        expires_at + ${ms} * interval '1 millisecond',
        created_at + ${config.limits.maxRoomMs} * interval '1 millisecond')
      where id = ${roomId}`);
    await notify(tx, roomId, 'room');
  });
}

export async function endRoom(ownerId: string, roomId: string): Promise<void> {
  await ownedRoom(ownerId, roomId);
  await db.transaction(async (tx) => {
    await tx.delete(rooms).where(eq(rooms.id, roomId));
    await notify(tx, roomId, 'end');
  });
}

/** A one-time link that hands the owner's seat to the owner's agent. */
export async function ownerSeatLink(ownerId: string, roomId: string): Promise<string> {
  await ownedRoom(ownerId, roomId);
  const [seat] = await db
    .select({ id: seats.id })
    .from(seats)
    .where(and(eq(seats.roomId, roomId), eq(seats.role, 'owner')));
  if (!seat) throw new RoomError('not_found', 'This room has no owner seat.');
  return issueReconnect(seat.id);
}

// Agent side

async function loadRoom(roomId: string): Promise<RoomView> {
  const [row] = await db
    .select({ room: rooms, ownerName: users.name })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.ownerId))
    .where(eq(rooms.id, roomId));
  if (!row) throw ended();
  return { ...row.room, ownerName: row.ownerName };
}

export interface InviteInfo {
  room: RoomView;
  seatsLeft: number;
  usable: boolean;
  reason?: string;
}

/** What a GET on a claim link shows. Never takes a seat. */
export async function describeInvite(code: string): Promise<InviteInfo> {
  const [invite] = await db.select().from(invites).where(eq(invites.codeHash, sha256(code)));
  if (!invite) throw new RoomError('not_found', 'This link does not exist, or its room has ended.');
  const room = await loadRoom(invite.roomId);
  if (room.expiresAt.getTime() <= Date.now()) throw ended();
  const seatsLeft = Math.max(0, room.guestSeatLimit - (await guestSeatsTaken(db, room.id)));
  let reason: string | undefined;
  if (invite.revokedAt) reason = 'The owner revoked this link.';
  else if (invite.claimsAllowed !== null && invite.claimsUsed >= invite.claimsAllowed) reason = 'This link has been used.';
  else if (seatsLeft === 0) reason = 'Every guest seat is taken.';
  return { room, seatsLeft, usable: !reason, reason };
}

export interface Claimed extends SeatContext {
  pass: string;
  watchCode: string;
}

export async function claimSeat(code: string, rawName: unknown): Promise<Claimed> {
  const name = cleanName(rawName);
  const claimed = await db.transaction(async (tx) => {
    const [invite] = await tx.select().from(invites).where(eq(invites.codeHash, sha256(code)));
    if (!invite) throw new RoomError('not_found', 'This link does not exist, or its room has ended.');
    const room = await lockRoom(tx, invite.roomId);
    if (!room?.live) throw ended();
    const [current] = await tx.select().from(invites).where(eq(invites.id, invite.id)).for('update');
    if (!current || current.revokedAt) throw new RoomError('forbidden', 'The owner revoked this link.');
    if (current.claimsAllowed !== null && current.claimsUsed >= current.claimsAllowed) {
      throw new RoomError('full', 'This link has been used.');
    }
    if ((await guestSeatsTaken(tx, invite.roomId)) >= room.guestSeatLimit) {
      throw new RoomError('full', 'Every guest seat in this room is taken.');
    }
    const clash = await tx.execute(
      sql`select 1 from seats where room_id = ${invite.roomId} and lower(display_name) = lower(${name}) and released_at is null`,
    );
    if (clash.rows.length) throw new RoomError('name_taken', `Someone in this room is already called ${name}.`);

    const pass = newSecret();
    const watchCode = newSecret();
    const [seat] = await tx
      .insert(seats)
      .values({
        roomId: invite.roomId,
        inviteId: invite.id,
        displayName: name,
        role: 'guest',
        passHash: sha256(pass),
        watchHash: sha256(watchCode),
      })
      .returning();
    await tx
      .update(invites)
      .set({ claimsUsed: sql`${invites.claimsUsed} + 1` })
      .where(eq(invites.id, invite.id));
    await notify(tx, invite.roomId, 'seat');
    return { seat: seat!, pass, watchCode };
  });
  return { ...claimed, room: await loadRoom(claimed.seat.roomId) };
}

async function seatBy(column: 'pass_hash' | 'watch_hash', secret: string): Promise<SeatContext> {
  if (!secret) throw new RoomError('unauthorized', 'A seat pass is required.');
  const match = column === 'pass_hash' ? eq(seats.passHash, sha256(secret)) : eq(seats.watchHash, sha256(secret));
  const [row] = await db
    .select({ seat: seats, room: rooms, ownerName: users.name, live: sql<boolean>`${rooms.expiresAt} > now()` })
    .from(seats)
    .innerJoin(rooms, eq(rooms.id, seats.roomId))
    .innerJoin(users, eq(users.id, rooms.ownerId))
    .where(match);
  if (!row) {
    throw new RoomError(
      column === 'pass_hash' ? 'unauthorized' : 'not_found',
      column === 'pass_hash'
        ? 'This seat pass is not valid. A reconnect may have replaced it, or the room has ended.'
        : 'This watch page does not exist, or its room has ended.',
    );
  }
  if (!row.live) throw ended();
  if (row.seat.removedAt) throw new RoomError('forbidden', 'This seat was removed from the room.');
  return { seat: row.seat, room: { ...row.room, ownerName: row.ownerName } };
}

/** Checked on every request: the pass must match, the seat must be in place and the room live. */
export const seatByPass = (pass: string) => seatBy('pass_hash', pass);
export const seatByWatch = (code: string) => seatBy('watch_hash', code);

export async function roster(roomId: string): Promise<RosterEntry[]> {
  const rows = await db
    .select({ name: seats.displayName, role: seats.role })
    .from(seats)
    .where(and(eq(seats.roomId, roomId), isNull(seats.removedAt)))
    .orderBy(asc(seats.claimedAt));
  return rows;
}

export async function leaveSeat(ctx: SeatContext): Promise<void> {
  await db.transaction(async (tx) => {
    await lockRoom(tx, ctx.room.id);
    const [seat] = await tx
      .update(seats)
      .set({ removedAt: sql`now()`, releasedAt: sql`now()`, reconnectHash: null, reconnectExpiresAt: null })
      .where(and(eq(seats.id, ctx.seat.id), isNull(seats.removedAt), eq(seats.role, 'guest')))
      .returning({ inviteId: seats.inviteId });
    if (!seat) {
      if (ctx.seat.role === 'owner') throw new RoomError('forbidden', 'The owner seat stays until the room ends.');
      return;
    }
    await returnClaim(tx, seat.inviteId);
    await notify(tx, ctx.room.id, 'seat');
  });
}

export async function issueReconnect(seatId: string): Promise<string> {
  const code = newSecret();
  const done = await db
    .update(seats)
    .set({ reconnectHash: sha256(code), reconnectExpiresAt: sql`now() + ${config.reconnectLinkMs} * interval '1 millisecond'` })
    .where(and(eq(seats.id, seatId), isNull(seats.removedAt)))
    .returning({ id: seats.id });
  if (!done.length) throw new RoomError('forbidden', 'This seat was removed from the room.');
  return reconnectUrl(code);
}

export async function describeReconnect(code: string): Promise<SeatContext> {
  const [row] = await db
    .select({ seat: seats })
    .from(seats)
    .innerJoin(rooms, eq(rooms.id, seats.roomId))
    .where(
      and(
        eq(seats.reconnectHash, sha256(code)),
        isNull(seats.removedAt),
        gt(seats.reconnectExpiresAt, sql`now()`),
        gt(rooms.expiresAt, sql`now()`),
      ),
    );
  if (!row) throw new RoomError('not_found', 'This seat link was used, expired, or its room has ended.');
  return { seat: row.seat, room: await loadRoom(row.seat.roomId) };
}

/** Returns the same seat with a fresh pass. The old pass stops working. Single use. */
export async function redeemReconnect(code: string): Promise<SeatContext & { pass: string }> {
  const pass = newSecret();
  const seat = await db.transaction(async (tx) => {
    const [seat] = await tx
      .update(seats)
      .set({ passHash: sha256(pass), reconnectHash: null, reconnectExpiresAt: null })
      .where(
        and(
          eq(seats.reconnectHash, sha256(code)),
          isNull(seats.removedAt),
          gt(seats.reconnectExpiresAt, sql`now()`),
          sql`exists (select 1 from rooms r where r.id = ${seats.roomId} and r.expires_at > now())`,
        ),
      )
      .returning();
    if (!seat) throw new RoomError('not_found', 'This seat link was used, expired, or its room has ended.');
    await notify(tx, seat.roomId, 'seat');
    return seat;
  });
  return { seat, pass, room: await loadRoom(seat.roomId) };
}

// Messages

export async function postMessage(ctx: SeatContext, raw: unknown): Promise<MessageView> {
  const text = typeof raw === 'string' ? raw.replaceAll('\0', '').trimEnd() : '';
  if (!text.trim()) throw new RoomError('invalid', 'A message needs text.');
  if (Buffer.byteLength(text) > config.limits.maxMessageBytes) {
    throw new RoomError('too_large', `Messages are limited to ${Math.floor(config.limits.maxMessageBytes / 1024)} KB.`);
  }

  const { rows } = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from messages where seat_id = ${ctx.seat.id} and created_at > now() - interval '1 minute'`,
  );
  if ((rows[0]?.n ?? 0) >= config.limits.messagesPerMinute) {
    throw new RoomError('rate_limited', `A seat can send ${config.limits.messagesPerMinute} messages a minute. Wait a moment.`);
  }

  const hashes = [...new Set(text.match(SECRET_SHAPE) ?? [])].map(sha256);
  if (hashes.length) {
    const list = sql.join(hashes.map((h) => sql`${h}`), sql`, `);
    const leak = await db.execute(sql`
      select 1 from seats where room_id = ${ctx.room.id}
        and (pass_hash in (${list}) or watch_hash in (${list}) or reconnect_hash in (${list}))
      limit 1`);
    if (leak.rows.length) {
      throw new RoomError('forbidden', 'Messages cannot carry a seat pass, watch code or seat link from this room.');
    }
  }

  // The room lock makes message ids commit in order, so a reader's `after` never skips a later commit.
  return db.transaction(async (tx) => {
    if (!(await lockRoom(tx, ctx.room.id))?.live) throw ended();
    const [row] = await tx.insert(messages).values({ roomId: ctx.room.id, seatId: ctx.seat.id, text }).returning();
    await notify(tx, ctx.room.id, 'message');
    return { id: row!.id, seatId: ctx.seat.id, from: ctx.seat.displayName, role: ctx.seat.role, at: row!.createdAt, text };
  });
}

export async function readMessages(
  roomId: string,
  after: number,
  options: { limit?: number; excludeSeatId?: string } = {},
): Promise<MessageView[]> {
  const conditions = [eq(messages.roomId, roomId), gt(messages.id, after)];
  if (options.excludeSeatId) conditions.push(ne(messages.seatId, options.excludeSeatId));
  return db
    .select({
      id: messages.id,
      seatId: messages.seatId,
      from: seats.displayName,
      role: seats.role,
      at: messages.createdAt,
      text: messages.text,
    })
    .from(messages)
    .innerJoin(seats, eq(seats.id, messages.seatId))
    .where(and(...conditions))
    .orderBy(asc(messages.id))
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
}

export async function latestMessageId(roomId: string): Promise<number> {
  const [row] = await db.select({ id: messages.id }).from(messages).where(eq(messages.roomId, roomId)).orderBy(desc(messages.id)).limit(1);
  return row?.id ?? 0;
}

/**
 * Wakes on a room event, re-checks the gate with `check` and runs `poll`, until `poll` returns
 * something, the deadline passes or the signal aborts. A periodic re-check covers missed events.
 */
export async function untilRoomEvent<T>(
  roomId: string,
  options: { deadline: number; signal?: AbortSignal; check: () => Promise<{ expiresAt: Date }>; poll: () => Promise<T | undefined> },
): Promise<T | undefined> {
  let dirty = false;
  let wake: (() => void) | undefined;
  const off = onRoom(roomId, () => {
    dirty = true;
    wake?.();
  });
  try {
    for (;;) {
      dirty = false;
      const { expiresAt } = await options.check();
      const found = await options.poll();
      if (found !== undefined) return found;
      const remaining = Math.min(options.deadline, expiresAt.getTime()) - Date.now();
      if (remaining <= 0 || options.signal?.aborted) return undefined;
      if (dirty) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(remaining, 10_000));
        options.signal?.addEventListener('abort', done, { once: true });
        wake = done;
        function done() {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', done);
          wake = undefined;
          resolve();
        }
      });
    }
  } finally {
    off();
  }
}

export interface WaitResult {
  ctx: SeatContext;
  messages: MessageView[];
}

/** Holds until a message from someone else arrives after `after`, or the timeout passes. */
export async function waitForMessages(pass: string, after: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
  let ctx = await seatByPass(pass);
  const found = await untilRoomEvent(ctx.room.id, {
    deadline: Date.now() + timeoutMs,
    signal,
    check: async () => {
      ctx = await seatByPass(pass);
      return ctx.room;
    },
    poll: async () => {
      const list = await readMessages(ctx.room.id, after, { limit: 100, excludeSeatId: ctx.seat.id });
      return list.length ? list : undefined;
    },
  });
  return { ctx, messages: found ?? [] };
}

export async function fullTranscript(roomId: string): Promise<MessageView[]> {
  const out: MessageView[] = [];
  for (let after = 0; ; ) {
    const page = await readMessages(roomId, after, { limit: 500 });
    out.push(...page);
    if (page.length < 500) return out;
    after = page.at(-1)!.id;
  }
}

/** Deletes every ended room with its invites, seats and messages. */
export async function sweepEndedRooms(): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(sql`
    with gone as (delete from rooms where expires_at <= now() returning id)
    select id, pg_notify(${CHANNEL}, json_build_object('room', id, 'kind', 'end')::text) from gone`);
  return rows.length;
}
