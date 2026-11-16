import './env.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { app } from '../src/app.ts';
import { RoomError } from '../src/core/errors.ts';
import { startListening, stopListening } from '../src/core/events.ts';
import {
  claimSeat,
  createRoom,
  endRoom,
  mintDirectLink,
  postMessage,
  removeSeat,
  roomDetail,
  seatByPass,
  sweepEndedRooms,
  waitForMessages,
} from '../src/core/rooms.ts';
import { db, pool, runMigrations } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';

before(async () => {
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public');
  await runMigrations();
  await startListening();
});

after(async () => {
  await stopListening();
  await pool.end();
});

async function newOwner() {
  const id = randomUUID();
  await db.insert(users).values({ id, name: 'Owner', email: `${id}@acl.test` });
  return { id, name: 'Owner' };
}

async function newRoom(guestSeats: number) {
  const owner = await newOwner();
  const room = await createRoom(owner, { title: 'Test room', brief: 'Talk.', guestSeats, lifetimeMinutes: 60 });
  const detail = await roomDetail(owner.id, room.id);
  return { owner, room, sharedCode: detail.invites[0]!.url.split('/j/')[1]! };
}

const codeOf = (url: string) => url.split('/j/')[1]!;

async function settle(claims: Promise<unknown>[]) {
  const results = await Promise.allSettled(claims);
  for (const r of results) {
    if (r.status === 'rejected' && !(r.reason instanceof RoomError && r.reason.code === 'full')) throw r.reason;
  }
  return results.filter((r) => r.status === 'fulfilled').length;
}

test('many agents claiming at once never exceed the seat limit or a link claim count', async () => {
  const shared = await newRoom(3);
  const won = await settle(Array.from({ length: 25 }, (_, i) => claimSeat(shared.sharedCode, `agent ${i}`)));
  assert.equal(won, 3);

  const direct = await newRoom(5);
  const link = codeOf(await mintDirectLink(direct.owner.id, direct.room.id, 'one'));
  assert.equal(await settle(Array.from({ length: 10 }, (_, i) => claimSeat(link, `racer ${i}`))), 1);

  // Two links racing for the last seats of one room.
  const mixed = await newRoom(2);
  const other = codeOf(await mintDirectLink(mixed.owner.id, mixed.room.id, 'two'));
  const both = await settle(
    Array.from({ length: 12 }, (_, i) => claimSeat(i % 2 ? other : mixed.sharedCode, `mixed ${i}`)),
  );
  assert.equal(both, 2);
  assert.equal((await roomDetail(mixed.owner.id, mixed.room.id)).taken, 2);
});

async function mcpCall(name: string, pass: string) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { pass } } }),
  });
  const body = await res.text();
  const json = body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
  return JSON.parse(json).result as { isError?: boolean; content: { text: string }[] };
}

async function refusedEverywhere(pass: string, watchCode: string) {
  const api = await app.request('/api/room', { headers: { authorization: `Bearer ${pass}` } });
  assert.ok(api.status === 403 || api.status === 410, `api answered ${api.status}`);
  const tool = await mcpCall('room', pass);
  assert.equal(tool.isError, true);
  const watch = await app.request(`/w/${watchCode}`);
  assert.ok(watch.status === 403 || watch.status === 410, `watch page answered ${watch.status}`);
  const stream = await app.request(`/w/${watchCode}/stream`);
  assert.ok(stream.status === 403 || stream.status === 410, `watch stream answered ${stream.status}`);
}

test('an expired room and a removed seat are refused on the API, the connector and the watch page', async () => {
  const { owner, room, sharedCode } = await newRoom(3);
  const kept = await claimSeat(sharedCode, 'kept');
  const removed = await claimSeat(sharedCode, 'removed');

  assert.equal((await app.request('/api/room', { headers: { authorization: `Bearer ${kept.pass}` } })).status, 200);
  assert.notEqual((await mcpCall('room', kept.pass)).isError, true);
  assert.equal((await app.request(`/w/${kept.watchCode}`)).status, 200);

  await removeSeat(owner.id, room.id, removed.seat.id);
  await refusedEverywhere(removed.pass, removed.watchCode);

  await db.execute(sql`update rooms set expires_at = now() - interval '1 second' where id = ${room.id}`);
  await refusedEverywhere(kept.pass, kept.watchCode);
});

test('after a room ends, no row with its content remains', async () => {
  const marker = `marker-${randomUUID()}`;
  for (const ending of ['owner', 'expiry'] as const) {
    const { owner, room, sharedCode } = await newRoom(2);
    await mintDirectLink(owner.id, room.id, marker);
    const seat = await claimSeat(sharedCode, 'talker');
    await postMessage(seat, `${marker} secret plans`);

    if (ending === 'owner') await endRoom(owner.id, room.id);
    else {
      await db.execute(sql`update rooms set expires_at = now() - interval '1 second' where id = ${room.id}`);
      assert.ok((await sweepEndedRooms()) >= 1);
    }

    const { rows } = await db.execute<{ n: number }>(sql`
      select (select count(*) from rooms where id = ${room.id})
        + (select count(*) from invites where room_id = ${room.id} or label = ${marker})
        + (select count(*) from seats where room_id = ${room.id})
        + (select count(*) from messages where room_id = ${room.id} or text like ${`%${marker}%`}) as n`);
    assert.equal(Number(rows[0]!.n), 0, `rows left after ${ending}`);
  }
});

test('a wait that times out and is called again with the same id returns every message sent in between', async () => {
  const { sharedCode } = await newRoom(2);
  const listener = await claimSeat(sharedCode, 'listener');
  const talker = await seatByPass((await claimSeat(sharedCode, 'talker')).pass);

  const first = await waitForMessages(listener.pass, 0, 200);
  assert.deepEqual(first.messages, []);

  const sent = [];
  for (const text of ['one', 'two', 'three']) sent.push((await postMessage(talker, text)).id);

  const again = await waitForMessages(listener.pass, 0, 200);
  assert.deepEqual(
    again.messages.map((m) => m.id),
    sent,
  );
});
