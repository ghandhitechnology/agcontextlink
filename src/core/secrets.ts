import { createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

/** 256-bit random value, 43 base64url characters. */
export const newSecret = (): string => randomBytes(32).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Claim codes are derived from the invite id with the server secret, so the owner's room page
 * can show the link again while the database keeps only its hash.
 */
export const claimCode = (inviteId: string): string =>
  createHmac('sha256', config.secret).update(`invite:${inviteId}`).digest('base64url');

/** Anything shaped like one of our secrets, for the in-room handover check. */
export const SECRET_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
