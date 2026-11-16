import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true });

// Owner accounts. The four auth tables follow Better Auth's model.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: time('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: time('access_token_expires_at'),
  refreshTokenExpiresAt: time('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});

export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    guestSeatLimit: integer('guest_seat_limit').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [index('rooms_owner_idx').on(t.ownerId), index('rooms_expires_idx').on(t.expiresAt)],
);

// A claim link. The shared link has no claim cap; a direct link allows one claim.
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    claimsAllowed: integer('claims_allowed'),
    claimsUsed: integer('claims_used').notNull().default(0),
    label: text('label'),
    createdAt: time('created_at').notNull().defaultNow(),
    revokedAt: time('revoked_at'),
  },
  (t) => [index('invites_room_idx').on(t.roomId)],
);

// removedAt: the seat no longer works. releasedAt: the seat no longer counts toward the guest limit.
export const seats = pgTable(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    inviteId: uuid('invite_id').references(() => invites.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['owner', 'guest'] }).notNull(),
    passHash: text('pass_hash').unique(),
    watchHash: text('watch_hash').unique(),
    reconnectHash: text('reconnect_hash').unique(),
    reconnectExpiresAt: time('reconnect_expires_at'),
    claimedAt: time('claimed_at').notNull().defaultNow(),
    removedAt: time('removed_at'),
    releasedAt: time('released_at'),
  },
  (t) => [
    index('seats_room_idx').on(t.roomId),
    uniqueIndex('seats_room_name_idx')
      .on(t.roomId, sql`lower(${t.displayName})`)
      .where(sql`${t.releasedAt} is null`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id').notNull().references(() => seats.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [index('messages_room_idx').on(t.roomId, t.id), index('messages_seat_time_idx').on(t.seatId, t.createdAt)],
);

export type Room = typeof rooms.$inferSelect;
export type Seat = typeof seats.$inferSelect;
export type Invite = typeof invites.$inferSelect;
