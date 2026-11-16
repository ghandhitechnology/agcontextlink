import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const css = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --fg: #1b1b19; --muted: #6c6b66; --line: #e4e3de;
  --soft: #f0efeb; --accent: #2457e6; --danger: #b42318; --owner: #8a5a00;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312; --surface: #1b1b1a; --fg: #ebeae6; --muted: #9b9a94; --line: #2d2d2b;
    --soft: #232322; --accent: #86a6ff; --danger: #f97066; --owner: #e9b85a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--surface); }
.brand { font-weight: 650; letter-spacing: -0.01em; text-decoration: none; color: inherit; }
.top form { margin: 0; }
.who { color: var(--muted); font-size: 14px; display: flex; gap: 12px; align-items: center; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 20px 72px; }
main.narrow { max-width: 640px; }
h1 { font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 6px; text-wrap: balance; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted);
  font-weight: 600; margin: 0 0 10px; }
p { margin: 0; }
.meta { color: var(--muted); font-size: 14px; }
.stack { display: flex; flex-direction: column; gap: 28px; }
.panel { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn { border: 1px solid var(--line); background: var(--surface); color: var(--fg); padding: 7px 12px;
  border-radius: 8px; font: inherit; font-size: 14px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.btn.danger { color: var(--danger); }
.btn.small { padding: 3px 9px; font-size: 13px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--muted); }
input, textarea, select { font: inherit; color: var(--fg); background: var(--surface); width: 100%;
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
textarea { min-height: 110px; resize: vertical; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.copy { display: flex; gap: 6px; }
.copy input, code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
code { background: var(--soft); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.list > li { display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 10px 0; border-bottom: 1px solid var(--line); }
.list > li:last-child { border-bottom: 0; }
.list .grow { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.rooms > li a { font-weight: 600; text-decoration: none; color: inherit; }
.tag { font-size: 12px; color: var(--muted); }
.tag.owner { color: var(--owner); }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 40px; align-items: start; }
@media (max-width: 880px) { .layout { grid-template-columns: 1fr; } }
.side { display: flex; flex-direction: column; gap: 28px; }
.log { display: flex; flex-direction: column; gap: 18px; }
.msg .head { display: flex; gap: 8px; align-items: baseline; font-size: 14px; }
.msg .name { font-weight: 600; }
.msg .time { color: var(--muted); font-size: 12px; margin-left: auto; }
.msg .text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.msg.owner .name { color: var(--owner); }
.empty { color: var(--muted); }
.brief { white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid var(--line); padding-left: 12px; }
.note { background: var(--soft); border-radius: 8px; padding: 10px 12px; font-size: 14px; }
.error { color: var(--danger); }
.banner { position: sticky; top: 0; background: var(--fg); color: var(--bg); padding: 10px 14px;
  border-radius: 8px; margin-bottom: 16px; }
details > summary { cursor: pointer; color: var(--muted); font-size: 14px; }
details[open] > summary { margin-bottom: 8px; }
.steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.hero { display: flex; flex-direction: column; gap: 16px; padding-top: 10vh; }
.hero p { font-size: 17px; color: var(--muted); max-width: 46ch; }
`;

const script = `
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const field = document.getElementById(b.dataset.copy);
  navigator.clipboard.writeText(field.value || field.textContent).then(() => {
    const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was; }, 1400);
  });
});
const log = document.querySelector('[data-stream]');
if (log) {
  const es = new EventSource(log.dataset.stream);
  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (document.getElementById('m' + m.id)) return;
    log.querySelector('.empty')?.remove();
    const follow = atBottom();
    const item = el('article', 'msg ' + m.role); item.id = 'm' + m.id;
    const head = el('div', 'head');
    head.append(el('span', 'name', m.from), el('span', 'tag ' + m.role, m.role),
      el('span', 'time', new Date(m.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })));
    item.append(head, el('div', 'text', m.text));
    log.append(item);
    if (follow) window.scrollTo(0, document.body.scrollHeight);
  });
  es.addEventListener('roster', (e) => {
    const target = document.querySelector('[data-roster]');
    if (!target) return;
    if (target.dataset.roster) {
      fetch(target.dataset.roster).then((r) => (r.ok ? r.text() : '')).then((h) => { if (h) target.innerHTML = h; });
    } else {
      target.replaceChildren(...JSON.parse(e.data).map((r) => {
        const li = el('li'); li.append(el('span', 'grow', r.name), el('span', 'tag ' + r.role, r.role)); return li;
      }));
    }
  });
  es.addEventListener('end', (e) => {
    es.close();
    const banner = document.querySelector('.banner');
    if (banner) { banner.textContent = e.data; banner.hidden = false; }
    document.querySelectorAll('form[data-live]').forEach((f) => f.remove());
  });
}
`;

export function layout(options: { title: string; body: Html; owner?: { name: string }; narrow?: boolean }): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="referrer" content="no-referrer" />
    <title>${options.title}</title>
    <style>${raw(css)}</style>
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/">agcontextlink</a>
      ${options.owner
        ? html`<div class="who">
            <span>${options.owner.name}</span>
            <form method="post" action="/signout"><button class="btn small">Sign out</button></form>
          </div>`
        : ''}
    </header>
    <main class="${options.narrow ? 'narrow' : ''}">${options.body}</main>
    <script>${raw(script)}</script>
  </body>
</html>`;
}
