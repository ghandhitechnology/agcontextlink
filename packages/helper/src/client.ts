import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const VERSION = '0.1.0';
const USER_AGENT = `agcontextlink-helper/${VERSION}`;

/** Statuses that can mean the seat pass is dead. Confirmed with a /api/room call before dropping it. */
const MAYBE_DEAD = new Set([401, 403, 410]);

export interface RoomLink {
  url: string;
  origin: string;
  kind: 'claim' | 'reconnect';
}

export function parseLink(raw: string): RoomLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a link: ${raw}`);
  }
  const match = /^\/(j|r)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match || !/^https?:$/.test(url.protocol)) {
    throw new Error('Expected a room link like https://host/j/<code> or a seat link like https://host/r/<code>.');
  }
  return { url: `${url.origin}/${match[1]}/${match[2]}`, origin: url.origin, kind: match[1] === 'j' ? 'claim' : 'reconnect' };
}

export interface SavedSeat {
  pass: string;
  name: string;
  role: string;
  title: string;
  watchUrl?: string;
  /** Last message id already seen, so pushes resume where they stopped. */
  lastId: number;
}

export interface StreamMessage {
  id: number;
  from: string;
  role: string;
  at: string;
  own: boolean;
  content: string;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Plain-text error body.
  }
  return body.trim() || `Request failed with status ${res.status}.`;
}

/** fetch, with network failures reported as a readable error. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new HttpError(0, `Could not reach ${new URL(url).origin}.`);
  }
}

/** One room seat: the link it came from, the saved pass, and calls to the room's HTTP API. */
export class RoomClient {
  readonly link: RoomLink;
  seat?: SavedSeat;
  private readonly file: string;

  constructor(link: RoomLink) {
    this.link = link;
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const key = createHash('sha256').update(link.url).digest('hex').slice(0, 32);
    this.file = join(base, 'agcontextlink', 'seats', `${key}.json`);
  }

  async load(): Promise<void> {
    try {
      this.seat = JSON.parse(await readFile(this.file, 'utf8')) as SavedSeat;
    } catch {
      this.seat = undefined;
    }
  }

  async save(): Promise<void> {
    if (!this.seat) return;
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.seat, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async drop(): Promise<void> {
    this.seat = undefined;
    await rm(this.file, { force: true });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...extra };
    if (this.seat) headers.authorization = `Bearer ${this.seat.pass}`;
    return headers;
  }

  /** Takes a seat from the link. A claim link needs a display name; a seat link does not. */
  async claim(name: string | undefined): Promise<{ text: string }> {
    const body = this.link.kind === 'claim' ? JSON.stringify({ name }) : undefined;
    const res = await request(this.link.url, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
    });
    if (!res.ok) throw new HttpError(res.status, await errorText(res));
    const data = (await res.json()) as {
      pass: string;
      watchUrl?: string;
      seat: { name: string; role: string };
      room: { title: string; owner: string; expiresAt: string };
      roster: { name: string; role: string }[];
      brief: string;
    };
    this.seat = { pass: data.pass, name: data.seat.name, role: data.seat.role, title: data.room.title, watchUrl: data.watchUrl, lastId: 0 };
    this.seat.lastId = await this.latestId();
    await this.save();

    const lines = [
      this.link.kind === 'reconnect'
        ? `Reconnected to "${data.room.title}" as ${data.seat.name} (${data.seat.role}). The previous pass no longer works.`
        : `You hold a seat in "${data.room.title}" as ${data.seat.name} (${data.seat.role}).`,
      `The room ends ${data.room.expiresAt}. Every message is deleted then.`,
      'This helper keeps the seat pass on this machine, so tools need no pass argument and a restart keeps the same seat.',
    ];
    if (data.watchUrl) lines.push('', `Watch page for your user: ${data.watchUrl}`, 'Give this address to the person you work for so they can follow the room.');
    lines.push(
      '',
      `Seated: ${data.roster.map((r) => `${r.name} (${r.role})`).join(', ')}`,
      '',
      data.brief,
      '',
      'Next: call read with after=0 to see the conversation so far. New messages from others are pushed to you when channels are on; otherwise call wait with the last id you saw.',
    );
    return { text: lines.join('\n') };
  }

  /** The id of the newest message, so the live stream pushes only what arrives after joining. */
  private async latestId(): Promise<number> {
    let after = 0;
    for (;;) {
      const res = await fetch(`${this.link.origin}/api/read?after=${after}&limit=500`, {
        headers: this.headers({ accept: 'application/json' }),
      });
      if (!res.ok) return after;
      const page = (await res.json()) as { lastId: number; more: boolean };
      after = page.lastId;
      if (!page.more) return after;
    }
  }

  /** Calls the seat API and returns its agent-ready text. */
  async call(path: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}): Promise<string> {
    if (!this.seat) throw new HttpError(401, 'Not seated yet. Call join first.');
    const res = await request(`${this.link.origin}/api${path}`, {
      method: init.method ?? 'GET',
      headers: this.headers(init.body === undefined ? {} : { 'content-type': 'text/plain; charset=utf-8' }),
      body: init.body,
      signal: init.signal,
    });
    if (!res.ok) throw new HttpError(res.status, await errorText(res));
    return res.text();
  }

  /** After a failed call: drops the saved pass when the server confirms it no longer works. */
  async dropIfDead(error: unknown): Promise<boolean> {
    if (!(error instanceof HttpError) || !MAYBE_DEAD.has(error.status) || !this.seat) return false;
    const res = await fetch(`${this.link.origin}/api/room`, { headers: this.headers() }).catch(() => undefined);
    if (!res || !MAYBE_DEAD.has(res.status)) return false;
    await this.drop();
    return true;
  }

  /**
   * Holds the room's event stream open, reconnecting with backoff, and hands over each new message.
   * Returns when the seat stops working (with the server's reason) or the signal aborts.
   */
  async stream(onMessage: (m: StreamMessage) => Promise<void>, signal: AbortSignal): Promise<string | undefined> {
    let delay = 1000;
    while (!signal.aborted && this.seat) {
      try {
        const seat = this.seat;
        const res = await fetch(`${this.link.origin}/api/stream?after=${seat.lastId}`, {
          headers: this.headers({ accept: 'text/event-stream', 'last-event-id': String(seat.lastId) }),
          signal,
        });
        if (MAYBE_DEAD.has(res.status) || res.status === 404) {
          const reason = await errorText(res);
          if (await this.dropIfDead(new HttpError(res.status, reason))) return reason;
          throw new Error(reason);
        }
        if (!res.ok || !res.body) throw new Error(`Stream failed with status ${res.status}.`);
        delay = 1000;
        for await (const event of sseEvents(res.body)) {
          if (event.event === 'message') {
            const m = JSON.parse(event.data) as StreamMessage;
            if (m.id <= seat.lastId) continue;
            seat.lastId = m.id;
            await this.save();
            if (!m.own) await onMessage(m);
          } else if (event.event === 'end') {
            if (await this.dropIfDead(new HttpError(410, event.data))) return event.data;
            break;
          }
        }
      } catch {
        if (signal.aborted) return undefined;
      }
      await sleep(delay, undefined, { signal }).catch(() => {});
      delay = Math.min(delay * 2, 30_000);
    }
    return undefined;
  }
}

interface SseEvent {
  event: string;
  data: string;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}
