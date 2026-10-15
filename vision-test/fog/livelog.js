// 🪵 The live log of our vision layer, for the GM box's "🪵 Live log" (popover.html, lightpanel.js):
// every screen's fog and door log lines in one place, so the DM sees what the phones and the
// projector did without their consoles.
//
//   LOG_SHOW, LOG_KEEP, LOG_BATCH_MS, LOG_SETTLE_MS, LOG_MAX_BYTES, LOG_TEXT_MAX, LOG_PENDING_MAX
//   clock(at) / lineText(line)   a line as the GM box shows it: "21:04:05 Ana (touch) door: → asked…"
//   createLiveLog(api, {me(), timers, echo})
//     -> {add(kind, text), lines(max), own(), start(), stop(), status()}
//
// Each screen keeps its own lines ({n, at, kind, text}; me() names the screen: {conn, host, name,
// kind, role}) and broadcasts the new ones on FOG_LOG_CH, batched: at most one message per
// LOG_BATCH_MS, each well under bus.js MAX_BYTES (what doesn't fit waits for the next one). A GM screen
// collects every screen's lines, its own as they're added, and lines(max) gives the newest first,
// each tagged with the screen it came from. Cheap by design: a line per event (a door asked, answered
// or written, the switch, the answerer changing, an error), never per frame or per pass.
// echo(text): this screen's console too (background.js's ctx.log).

import { FOG_LOG_CH } from "../keys.js?v=bb4ddf1";
import { on, send } from "../bus.js?v=bb4ddf1";

export const LOG_SHOW = 40; // lines the GM box shows
export const LOG_KEEP = 60; // a screen's own lines kept, and the lines a GM screen holds
export const LOG_BATCH_MS = 2000; // at most one broadcast this often
export const LOG_SETTLE_MS = 250; // ...a burst of lines goes out in one
export const LOG_MAX_BYTES = 6000; // one broadcast at most (bus.js refuses over 15000)
export const LOG_TEXT_MAX = 220; // one line's text at most
export const LOG_PENDING_MAX = 120; // lines waiting to go out at most (the oldest go first)

const bytes = (s) => (typeof TextEncoder === "function" ? new TextEncoder().encode(s).length : s.length);
const pad = (n) => String(n).padStart(2, "0");

export function clock(at) {
  const d = new Date(Number(at) || 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const lineText = (l) => `${clock(l?.at)} ${l?.who || "?"}${l?.scr ? ` (${l.scr})` : ""} ${l?.kind || "fog"}: ${l?.text ?? ""}`;

export function createLiveLog(api, { me = () => ({}), timers = null, echo = null } = {}) {
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  let n = 0;
  let started = false, off = null, timer = null, lastSent = -Infinity;
  let sent = 0, dropped = 0;
  const own = []; // this screen's lines, oldest first
  const pending = []; // own lines not broadcast yet
  const all = []; // a GM screen's: every screen's lines, oldest first
  const seen = new Set(); // `${from}|${host}|${n}` of the lines in `all`

  const self = () => {
    let m = {};
    try { m = me() || {}; } catch { m = {}; }
    return { conn: m.conn ?? null, host: String(m.host ?? ""), who: String(m.name || (m.role === "GM" ? "DM" : "a player")),
             scr: String(m.kind || ""), gm: m.role === "GM" };
  };

  function collect(line) {
    const k = `${line.from}|${line.host}|${line.n}`;
    if (seen.has(k)) return;
    seen.add(k);
    all.push(line);
    all.sort((a, b) => a.at - b.at || a.n - b.n); // devices' clocks differ a little: near enough
    while (all.length > LOG_KEEP) {
      const x = all.shift();
      seen.delete(`${x.from}|${x.host}|${x.n}`);
    }
  }

  function add(kind, text) {
    const w = self();
    const line = { n: ++n, at: T.now(), kind: String(kind || "fog"), text: String(text ?? "").slice(0, LOG_TEXT_MAX) };
    own.push(line);
    while (own.length > LOG_KEEP) own.shift();
    try { echo?.(`fog ${line.kind}: ${line.text}`); } catch { /* the console is optional */ }
    if (w.gm) collect({ ...line, from: w.conn, host: w.host, who: w.who, scr: w.scr });
    pending.push(line);
    while (pending.length > LOG_PENDING_MAX) {
      pending.shift();
      dropped++;
    }
    if (started) queue();
    return line;
  }

  function queue() {
    if (timer || !pending.length) return;
    timer = T.setTimeout(flush, Math.max(LOG_SETTLE_MS, lastSent + LOG_BATCH_MS - T.now()));
  }

  function flush() {
    timer = null;
    if (!started || !pending.length) return;
    const w = self();
    const msg = { audience: "gm", from: w.conn, host: w.host, who: w.who, scr: w.scr, lines: [] };
    let size = bytes(JSON.stringify(msg)) + 80; // + bus.js's v and mid
    while (pending.length) {
      const s = bytes(JSON.stringify(pending[0])) + 1;
      if (msg.lines.length && size + s > LOG_MAX_BYTES) break;
      msg.lines.push(pending.shift());
      size += s;
    }
    send(api, FOG_LOG_CH, msg, "ALL");
    lastSent = T.now();
    sent++;
    queue(); // the rest, LOG_BATCH_MS later
  }

  // Another screen's lines (a GM screen keeps them; a player's screen drops them unread).
  function onLog(msg, ev) {
    const w = self();
    if (!w.gm || !Array.isArray(msg?.lines) || ev?.local) return; // our own: kept as they were added
    const from = msg.from ?? ev?.connectionId ?? null;
    const host = String(msg.host ?? "");
    if (from === w.conn && host === w.host) return;
    for (const l of msg.lines.slice(0, 200)) {
      if (!l || typeof l.text !== "string" || !Number.isFinite(Number(l.n))) continue;
      collect({ n: Number(l.n), at: Number(l.at) || T.now(), kind: String(l.kind || "fog").slice(0, 20),
                text: l.text.slice(0, LOG_TEXT_MAX), from, host, who: String(msg.who || "?").slice(0, 40),
                scr: String(msg.scr || "").slice(0, 10) });
    }
  }

  function start() {
    if (started) return;
    started = true;
    off = on(api, FOG_LOG_CH, onLog);
    queue();
  }

  function stop() {
    if (!started) return;
    started = false;
    try { off?.(); } catch { /* gone */ }
    off = null;
    if (timer) T.clearTimeout(timer);
    timer = null;
  }

  return {
    add,
    lines: (max = LOG_SHOW) => (max > 0 ? all.slice(-max).reverse() : []), // newest first
    own: () => own.slice(),
    start,
    stop,
    status: () => ({ own: own.length, held: all.length, pending: pending.length, sent, dropped }),
  };
}
