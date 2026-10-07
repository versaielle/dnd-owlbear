// The aim tool's HUD: a small bar at the bottom of the map while aiming.
//   [⟲] [⟳]  "Fireball · 20-ft-radius sphere · 3 caught"  [✕] [✓ Cast]
// In pick mode a row of target chips sits above it ("Bandit 35 ft"). It talks to the tool in
// the background frame over the LOCAL broadcast channel dnd-npc/local/hud:
//   HUD -> tool  {cmd: "hello"|"lock"|"cancel"|"rotate-left"|"rotate-right"|"pick", id?, shift?}
//   tool -> HUD  {state: {...} | null}
// After a click the keyboard focus sits in this popover, so it handles Enter, Esc and [ ] itself
// and forwards them (the arrows too, only when the tool opened it with ?arrows=1). hudHtml and
// keyToCmd are pure (checked by check_aim.mjs); mountHud wires them to the page (hud.html).
import { CH, DEFAULT_COLOR } from "./consts.js?v=07c06cc";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (f) => new URL(`../icons/${f}`, import.meta.url).href;
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : DEFAULT_COLOR);

export function keyToCmd(e, { arrows = false } = {}) {
  // A key pressed in the HUD, as the command the tool understands (null: not ours).
  const k = e?.key;
  if (k === "Enter") return { cmd: "lock" };
  if (k === "Escape") return { cmd: "cancel" };
  if (k === "[" || k === "{") return { cmd: "rotate-left", shift: !!e.shiftKey || k === "{" };
  if (k === "]" || k === "}") return { cmd: "rotate-right", shift: !!e.shiftKey || k === "}" };
  if (arrows && k === "ArrowLeft") return { cmd: "rotate-left", shift: !!e.shiftKey };
  if (arrows && k === "ArrowRight") return { cmd: "rotate-right", shift: !!e.shiftKey };
  return null;
}

export function hudHtml(st) {
  // One dark panel: the status on a line of its own (full width), the buttons under it. The
  // middle of the button row carries the alert (too far, long range, odd grid, a note), or
  // on a keyboard the keys.
  if (!st) return `<div class="panel"><div class="line dim">…</div><div class="row"></div></div>`;
  const rotate = st.canRotate
    ? `<button class="sq" data-cmd="rotate-left" title="Turn left ([)" aria-label="Turn left"><img src="${icon("rotate-left.svg")}" alt=""></button>`
      + `<button class="sq" data-cmd="rotate-right" title="Turn right (])" aria-label="Turn right"><img src="${icon("rotate-right.svg")}" alt=""></button>`
    : "";
  let chips = "";
  if (st.mode === "pick") {
    const list = (st.chips || []).map((c) => {
      const cls = ["chip", c.id === st.picked ? "on" : "", c.long ? "long" : "", c.secret ? "secret" : ""].filter(Boolean).join(" ");
      return `<button class="${cls}" data-cmd="pick" data-id="${esc(c.id)}">${esc(c.label)}</button>`;
    }).join("");
    chips = `<div class="chips">${list || `<span class="pill dim">Nobody in range: tap a token on the map</span>`}</div>`;
  }
  const alert = st.note || st.alert || (st.warn ? `⚠ ${st.warn}` : "");
  const main = alert && String(st.status).endsWith(` · ${alert}`) ? String(st.status).slice(0, -(alert.length + 3)) : String(st.status ?? "");
  const line = `<div class="line${st.inRange === false ? " far" : ""}" title="${esc(st.status)}" aria-live="polite">${esc(main)}</div>`;
  const mid = alert ? `<div class="mid alert">${esc(alert)}</div>`
    : st.keys ? `<div class="mid hint"><span>Enter cast</span> · <span>Esc cancel</span>${st.canRotate ? " · <span>[ ] turn</span>" : ""}</div>` : `<div class="mid"></div>`;
  const cancel = `<button class="sq" data-cmd="cancel" title="Cancel (Esc)" aria-label="Cancel"><img src="${icon("cancel.svg")}" alt=""></button>`;
  const go = `<button class="go" data-cmd="lock" style="--c:${hex(st.color)}"${st.ready ? "" : " disabled"}><img src="${icon("cast.svg")}" alt="">Cast</button>`;
  return `${chips}<div class="panel">${line}<div class="row">${rotate}${mid}${cancel}${go}</div></div>`;
}

export function mountHud(doc, OBR, { channel = CH.LOCAL_HUD, arrows = false } = {}) {
  const root = doc.getElementById("hud") || doc.body;
  let st = null;
  const send = (m) => {
    try {
      const p = OBR.broadcast.sendMessage(channel, m, { destination: "LOCAL" });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // the tool is gone; nothing to tell
    }
  };
  const render = () => {
    root.innerHTML = hudHtml(st);
  };
  root.addEventListener("click", (ev) => {
    const b = ev.target?.closest?.("[data-cmd]");
    if (!b || b.disabled) return;
    send({ cmd: b.dataset.cmd, ...(b.dataset.id ? { id: b.dataset.id } : {}), shift: !!ev.shiftKey });
  });
  doc.addEventListener("keydown", (ev) => {
    const c = keyToCmd(ev, { arrows });
    if (!c) return;
    ev.preventDefault();
    send(c);
  });
  render();
  OBR.onReady(() => {
    OBR.broadcast.onMessage(channel, (ev) => {
      const d = ev?.data;
      if (d && "state" in d) {
        st = d.state;
        render();
      }
    });
    send({ cmd: "hello" });
  });
  return { show: (s) => ((st = s), render()), state: () => st };
}
