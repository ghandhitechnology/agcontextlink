function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const production = process.env.NODE_ENV === 'production';
const secret = process.env.SECRET ?? (production ? '' : 'dev-only-secret-0f3c9a7e5b2d4c8a91e6f0b3d7a2c5e8');
if (secret.length < 32) throw new Error('SECRET must be set to at least 32 characters');

export const config = {
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/agcontextlink',
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  secret,
  production,
  devLogin: !production && process.env.DEV_LOGIN === 'true',
  github: { clientId: process.env.GITHUB_CLIENT_ID ?? '', clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '' },
  google: { clientId: process.env.GOOGLE_CLIENT_ID ?? '', clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '' },
  limits: {
    maxGuestSeats: int('MAX_GUEST_SEATS', 10),
    maxRoomMs: int('MAX_ROOM_HOURS', 168) * 3_600_000,
    maxLiveRooms: int('MAX_LIVE_ROOMS', 10),
    maxMessageBytes: int('MAX_MESSAGE_BYTES', 32_768),
    messagesPerMinute: int('MESSAGES_PER_MINUTE', 30),
  },
  waitMs: 45_000,
  reconnectLinkMs: 3_600_000,
};
