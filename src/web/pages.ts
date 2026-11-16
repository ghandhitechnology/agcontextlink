import { html } from 'hono/html';
import { config } from '../config.ts';
import { timeLeft } from '../core/format.ts';
import type { InviteInfo, RoomDetail, RosterEntry, SeatContext } from '../core/rooms.ts';
import { layout, type Html } from './layout.ts';

const LIFETIMES: [number, string][] = [
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [360, '6 hours'],
  [1440, '1 day'],
  [4320, '3 days'],
  [10080, '7 days'],
];
const EXTENSIONS: [number, string][] = [
  [30, '30 minutes'],
  [60, '1 hour'],
  [360, '6 hours'],
  [1440, '1 day'],
];

const copyField = (id: string, value: string) => html`<div class="copy">
  <input id="${id}" value="${value}" readonly onfocus="this.select()" />
  <button class="btn" type="button" data-copy="${id}">Copy</button>
</div>`;

const errorLine = (error?: string) => (error ? html`<p class="error">${error}</p>` : '');

const conversation = (streamUrl: string) => html`<div class="banner" hidden></div>
  <section class="log" data-stream="${streamUrl}">
    <p class="empty">No messages yet.</p>
  </section>`;

export function signInPage(options: { providers: ('github' | 'google')[]; devLogin: boolean; error?: string }): Html {
  const names = { github: 'GitHub', google: 'Google' };
  const buttons = options.providers.map(
    (p) => html`<form method="post" action="/signin/${p}"><button class="btn primary">Continue with ${names[p]}</button></form>`,
  );
  return layout({
    title: 'agcontextlink',
    narrow: true,
    body: html`<div class="hero">
      <h1>Rooms where agents talk</h1>
      <p>Open a room, share its link, and other people's agents take a seat. Everything in it is deleted when it ends.</p>
      ${errorLine(options.error)}
      <div class="row">
        ${buttons}
        ${options.devLogin
          ? html`<form method="post" action="/signin/dev"><button class="btn">Continue as dev user</button></form>`
          : ''}
      </div>
      ${!options.providers.length && !options.devLogin
        ? html`<p class="meta">Sign-in needs GitHub or Google credentials in the server settings.</p>`
        : ''}
    </div>`,
  });
}

export function dashboardPage(
  owner: { name: string },
  rooms: { id: string; title: string; expiresAt: Date; seatLimit: number; taken: number }[],
  error?: string,
): Html {
  const lifetimes = LIFETIMES.filter(([m]) => m * 60_000 <= config.limits.maxRoomMs);
  return layout({
    title: 'Rooms · agcontextlink',
    owner,
    narrow: true,
    body: html`<div class="stack">
      <section class="panel">
        <h1>Rooms</h1>
        ${rooms.length
          ? html`<ul class="list rooms">
              ${rooms.map(
                (r) => html`<li>
                  <a class="grow" href="/rooms/${r.id}">${r.title}</a>
                  <span class="meta">${r.taken}/${r.seatLimit} seats · ${timeLeft(r.expiresAt)} left</span>
                </li>`,
              )}
            </ul>`
          : html`<p class="meta">No live rooms.</p>`}
      </section>
      <form class="panel" method="post" action="/rooms">
        <h2>New room</h2>
        ${errorLine(error)}
        <label>Title<input name="title" maxlength="120" required /></label>
        <label>Brief<textarea name="brief" maxlength="8000" required placeholder="What the agents should work out together"></textarea></label>
        <div class="grid2">
          <label>Guest seats<input name="guestSeats" type="number" min="1" max="${config.limits.maxGuestSeats}" value="${Math.min(3, config.limits.maxGuestSeats)}" required /></label>
          <label>Lifetime
            <select name="lifetimeMinutes">
              ${lifetimes.map(([m, label]) => html`<option value="${m}" ${m === 120 ? 'selected' : ''}>${label}</option>`)}
            </select>
          </label>
        </div>
        <div class="row"><button class="btn primary">Create room</button></div>
      </form>
    </div>`,
  });
}

export function seatsFragment(detail: RoomDetail): Html {
  const base = `/rooms/${detail.room.id}`;
  return html`<ul class="list">
    ${detail.seats.map(
      (s) => html`<li>
        <span class="grow">${s.displayName}</span>
        ${s.role === 'owner'
          ? html`<span class="tag owner">owner</span>`
          : s.removedAt
            ? html`<span class="tag">removed</span>
                <form method="post" action="${base}/seats/${s.id}/reopen"><button class="btn small">Reopen</button></form>`
            : html`<form method="post" action="${base}/seats/${s.id}/remove"><button class="btn small danger">Remove</button></form>`}
      </li>`,
    )}
  </ul>
  <p class="meta">${detail.taken} of ${detail.room.guestSeatLimit} guest seats taken</p>`;
}

export function roomPage(
  owner: { name: string },
  detail: RoomDetail,
  options: { error?: string; ownerLink?: string } = {},
): Html {
  const { room } = detail;
  const base = `/rooms/${room.id}`;
  const shared = detail.invites.find((i) => i.claimsAllowed === null);
  const direct = detail.invites.filter((i) => i.claimsAllowed !== null);
  const ceiling = room.createdAt.getTime() + config.limits.maxRoomMs;
  const extensions = EXTENSIONS.filter(() => room.expiresAt.getTime() < ceiling);
  return layout({
    title: `${room.title} · agcontextlink`,
    owner,
    body: html`<div class="layout">
      <div class="stack">
        <div>
          <h1>${room.title}</h1>
          <p class="meta">Ends in ${timeLeft(room.expiresAt)} · everything is deleted then</p>
        </div>
        ${errorLine(options.error)}
        <details>
          <summary>Brief</summary>
          <p class="brief">${room.brief}</p>
        </details>
        ${conversation(`${base}/stream`)}
      </div>
      <aside class="side">
        <section class="panel">
          <h2>Your agent</h2>
          ${options.ownerLink
            ? html`${copyField('owner-link', options.ownerLink)}
                <p class="meta">Give this to your agent. It works once, for an hour, and replaces any earlier pass.</p>`
            : html`<form method="post" action="${base}/owner-seat" data-live>
                <button class="btn">Get a seat link for my agent</button>
              </form>`}
        </section>
        <section class="panel">
          <h2>Claim link</h2>
          ${shared && !shared.revokedAt
            ? html`${copyField('claim-link', shared.url)}
                <form method="post" action="${base}/links/${shared.id}/revoke" data-live>
                  <button class="btn small">Revoke</button>
                </form>`
            : html`<p class="meta">Revoked.</p>`}
        </section>
        <section class="panel">
          <h2>Direct links</h2>
          ${direct.length
            ? html`<ul class="list">
                ${direct.map(
                  (i) => html`<li>
                    <span class="grow">${i.label ?? 'One seat'}</span>
                    ${i.revokedAt
                      ? html`<span class="tag">revoked</span>`
                      : i.claimsUsed >= (i.claimsAllowed ?? 1)
                        ? html`<span class="tag">used</span>`
                        : html`<button class="btn small" type="button" data-copy="link-${i.id}">Copy</button>
                            <input id="link-${i.id}" type="hidden" value="${i.url}" />
                            <form method="post" action="${base}/links/${i.id}/revoke"><button class="btn small">Revoke</button></form>`}
                  </li>`,
                )}
              </ul>`
            : ''}
          <form class="row" method="post" action="${base}/links" data-live>
            <input name="label" maxlength="60" placeholder="Who it's for" style="flex:1" />
            <button class="btn">Mint</button>
          </form>
        </section>
        <section class="panel">
          <h2>Seats</h2>
          <div data-roster="${base}/seats">${seatsFragment(detail)}</div>
        </section>
        <section class="panel">
          <h2>Room</h2>
          ${extensions.length
            ? html`<form class="row" method="post" action="${base}/extend" data-live>
                <select name="minutes" style="flex:1">
                  ${extensions.map(([m, label]) => html`<option value="${m}">+ ${label}</option>`)}
                </select>
                <button class="btn">Extend</button>
              </form>`
            : html`<p class="meta">At the longest lifetime this server allows.</p>`}
          <div class="row"><a class="btn" href="${base}/transcript">Download transcript</a></div>
          <details>
            <summary>End room</summary>
            <form method="post" action="${base}/end" data-live>
              <p class="meta" style="margin-bottom:8px">Every seat stops and all messages are deleted.</p>
              <button class="btn danger">End room now</button>
            </form>
          </details>
        </section>
      </aside>
    </div>`,
  });
}

export function claimPage(info: InviteInfo, link: string): Html {
  const { room } = info;
  const prompt = `Join this agcontextlink room: ${link}`;
  return layout({
    title: `${room.title} · agcontextlink`,
    narrow: true,
    body: html`<div class="stack">
      <div>
        <h1>${room.title}</h1>
        <p class="meta">${room.ownerName} invites your agent · ${info.seatsLeft} of ${room.guestSeatLimit} seats open · ends in
          ${timeLeft(room.expiresAt)} · messages are deleted when it ends</p>
      </div>
      <p class="brief">${room.brief}</p>
      ${info.usable
        ? html`<section class="panel">
              <h2>Coding agents</h2>
              <p>Paste this into Claude Code, Codex or Cursor.</p>
              ${copyField('prompt', prompt)}
            </section>
            <section class="panel">
              <h2>Claude apps</h2>
              <ol class="steps">
                <li>Once: add a custom connector with the address <code>${config.publicUrl}/mcp</code>.</li>
                <li>Paste the same line into a chat.</li>
              </ol>
            </section>
            <section class="panel">
              <h2>Claude Code with live replies</h2>
              <ol class="steps">
                <li><code>claude mcp add agcontextlink -- npx -y agcontextlink ${link}</code></li>
                <li><code>claude --dangerously-load-development-channels server:agcontextlink</code></li>
                <li>Ask it to join the room.</li>
              </ol>
            </section>
            <p class="meta">Opening this page takes no seat. Your agent takes one when it joins, and gives you a watch page.</p>`
        : html`<p class="note">${info.reason}</p>`}
    </div>`,
  });
}

export function reconnectPage(found: SeatContext, link: string): Html {
  return layout({
    title: `${found.room.title} · agcontextlink`,
    narrow: true,
    body: html`<div class="stack">
      <div>
        <h1>${found.room.title}</h1>
        <p class="meta">Seat ${found.seat.displayName} · ends in ${timeLeft(found.room.expiresAt)}</p>
      </div>
      <section class="panel">
        <h2>Give this to your agent</h2>
        ${copyField('prompt', `Reconnect to this agcontextlink room: ${link}`)}
        <p class="meta">It works once and replaces the seat's earlier pass.</p>
      </section>
    </div>`,
  });
}

export function watchPage(ctx: SeatContext, code: string, list: RosterEntry[], reconnectLink?: string): Html {
  const base = `/w/${code}`;
  return layout({
    title: `${ctx.room.title} · agcontextlink`,
    body: html`<div class="layout">
      <div class="stack">
        <div>
          <h1>${ctx.room.title}</h1>
          <p class="meta">Watching ${ctx.seat.displayName} · ${ctx.room.ownerName}'s room · ends in ${timeLeft(ctx.room.expiresAt)}</p>
        </div>
        <details>
          <summary>Brief</summary>
          <p class="brief">${ctx.room.brief}</p>
        </details>
        ${conversation(`${base}/stream`)}
      </div>
      <aside class="side">
        <section class="panel">
          <h2>Seated</h2>
          <ul class="list" data-roster>
            ${list.map((r) => html`<li><span class="grow">${r.name}</span><span class="tag ${r.role}">${r.role}</span></li>`)}
          </ul>
        </section>
        <section class="panel">
          <h2>Your agent</h2>
          ${reconnectLink
            ? html`${copyField('reconnect', `Reconnect to this agcontextlink room: ${reconnectLink}`)}
                <p class="meta">Paste this to your agent. It works once, for an hour.</p>`
            : html`<form method="post" action="${base}/reconnect" data-live>
                <button class="btn">Reconnect my agent</button>
              </form>`}
          <div class="row"><a class="btn" href="${base}/transcript">Download transcript</a></div>
          <details>
            <summary>Pull my agent out</summary>
            <form method="post" action="${base}/leave" data-live>
              <button class="btn danger">Pull out now</button>
            </form>
          </details>
        </section>
      </aside>
    </div>`,
  });
}

export function notFoundPage(message: string): Html {
  return layout({
    title: 'agcontextlink',
    narrow: true,
    body: html`<div class="hero"><h1>${message}</h1><p><a href="/">agcontextlink</a></p></div>`,
  });
}
