// The bridge: the one GM tab on the Dell that talks to the DND panel (panel.py) for the whole
// room. Every other screen (the laptop, the projector's Cast receiver, the players' phones)
// only hears it over Owlbear broadcasts, because only the Dell can reach the panel.
//
//   find the panel   served from localhost: that's it. From the public Pages site: only when
//                    this tab opted in ("🖥 This PC runs the DND panel"), by asking
//                    http://localhost:7420..7429/api/map/hello and keeping the first that answers.
//   the lease        GET /api/map/hello?conn=…&room=…: the panel picks ONE tab to listen to. Any
//                    other opted-in tab waits on standby and asks again every 10 s: no report, no
//                    jobs, no badges, no Grimoire copy. Each tab says its Owlbear room (OBR.room.id,
//                    and its name when known), so the panel's ✨ row can warn when a tab in another
//                    room (TheCozyBooze) holds the lease and offer "use that tab".
//   jobs             a long poll (GET /api/map/todo?conn=…&wait=15) that comes back as soon as the
//                    panel queues something, so a job reaches the map in about 50 ms.
//   up               what the other screens send it (an aim locked, a player's cast request, the
//                    laptop's 🗺 menus), checked against who Owlbear says sent it, then POSTed on.
//   heartbeat        every 5 s to every screen: the panel's settings and which tokens are PCs.
//
// On game night the Dell's GM tab runs TWO copies of the extension (the dual install, spec
// 14.5 and A12): the one served by the panel on this PC is the bridge, and the one from the
// Pages site draws the effects and aims. background.js decides that and sets ctx.relayOnly;
// then this copy draws nothing and sends its REMOTE messages to ALL, so the Pages copy on this
// same tab hears them too.
//
// Every Owlbear call and fetch goes through `api` and `mods`, so check_bridge.mjs can run it
// against a fake room and a fake clock.
import { CH, DEFAULT_SETTINGS, LS, PANEL_PORTS, RPC_PATHS, canSeal, lsGet, lsSet, on, seal, send, setConnection,
  setSceneWrite } from "./bus.js?v=07c06cc";
import { RING_KEY, TARGET_COLOR } from "./keys.js?v=07c06cc";

const HELLO_TIMEOUT_MS = 800; // per port, when looking for the panel
const FIND_RETRY_MS = 30000; // no panel found: look again
const STANDBY_RETRY_MS = 10000; // another tab holds the lease: ask again
const HEARTBEAT_MS = 5000;
const REPORT_EVERY_MS = 10000; // the map report rides the job loop when the 10 s timer is late
const LONG_POLL_S = 15;
const PANEL_DOWN_MS = 20000;
const LEGACY_POLL_MS = 1000; // an older panel without the long poll: ask every second, as before
const QUICK_EMPTY_MS = 250; // a "long" poll that came straight back empty: don't spin
const ERROR_RETRY_MS = 2000;
const ERRORS_BEFORE_FIND = 3; // then the panel may have moved port: look for it again
const SCREEN_GONE_MS = 90000; // a screen that hasn't said hello for this long is dropped

const defaultTimers = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (t) => clearInterval(t),
  now: () => Date.now(),
};

// A token's space on the map (left/top/right/bottom), from its image the way tokenBox reads it.
export function footprint(item, dpi) {
  const p = item?.position;
  if (!p) return null;
  if (!item.image || !item.grid?.dpi) return { l: p.x, t: p.y, r: p.x, b: p.y };
  const k = dpi / item.grid.dpi;
  const sx = Math.abs(item.scale?.x ?? 1), sy = Math.abs(item.scale?.y ?? 1);
  const l = p.x - (item.grid.offset?.x ?? item.image.width / 2) * k * sx;
  const t = p.y - (item.grid.offset?.y ?? item.image.height / 2) * k * sy;
  return { l, t, r: l + item.image.width * k * sx, b: t + item.image.height * k * sy };
}

// Feet from one space to another (or to a point), counted the way the grid measures, rounded
// to 5 ft. Token to token adds the one square the 5e count starts with (adjacent = 5 ft).
// Only for the panel's "too far" hint on a player's request; the aim tool does its own.
export function feetBetween(a, b, grid, { tokens = false } = {}) {
  if (!a || !b || !(grid?.dpi > 0)) return null;
  const dx = Math.max(0, b.l - a.r, a.l - b.r) / grid.dpi;
  const dy = Math.max(0, b.t - a.b, a.t - b.b) / grid.dpi;
  const m = String(grid.measurement || "CHEBYSHEV").toUpperCase();
  let cells = m === "EUCLIDEAN" ? Math.hypot(dx, dy) : m === "MANHATTAN" ? dx + dy
    : m === "ALTERNATING" ? Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2) : Math.max(dx, dy);
  if (tokens) cells += 1;
  return Math.round((cells * (grid.multiplier || 5)) / 5) * 5;
}

export function mergeEvents(pub, gm) {
  // The bridge draws the whole event: the public parts plus the GM-only ones.
  if (!gm) return pub || null;
  if (!pub) return gm;
  return {
    ...pub,
    ...gm,
    template: gm.template ?? pub.template ?? null,
    pcs: [...new Set([...(pub.pcs || []), ...(gm.pcs || [])])],
    parts: [...(pub.parts || []), ...(gm.parts || [])],
  };
}

// What /api/map/check sends back names hidden monsters, NPC tokens (hidden ones too), marked rooms
// and places not on the map yet. An RPC reply in the clear goes to every device in the room
// (R2), so when it can't be sealed for the asking device only counts go over the air; the map
// check shows those counts.
export function checkForRpc(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = { ...body };
  for (const k of ["creatures", "npcs", "rooms"]) {
    if (!(k in out)) continue;
    if (Array.isArray(out[k])) out[`${k}_count`] = out[k].length;
    delete out[k];
  }
  delete out.places_without_room;
  return out;
}

// The Owlbear room's name from the address Owlbear sent as this page's referrer
// (https://www.owlbear.rodeo/room/<id>/<name>), or "": Owlbear often sends only its origin.
export function roomNameOf(referrer) {
  const m = /\/room\/[^/]+\/([^/?#]+)/.exec(String(referrer || ""));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// How a room is named to the DM, as on the panel's ✨ row: its name, else its id as the tab's
// address shows it (owlbear.rodeo/room/<id>/…), since Owlbear seldom tells a tab the name. "" if neither.
export function roomLabel(id, name) {
  return name ? `room ${name}` : id ? `room ${id} (owlbear.rodeo/room/${id}/…)` : "";
}

// Why a laptop without WebCrypto gets no catalog: it would name every place and NPC of the
// adventure on every device in the room.
export const CATALOG_IN_CLEAR =
  "This device can't receive the adventure's place and NPC names privately. Use the 🗺 menus on the Dell's tab.";

const inert = { isBridge: () => false, stop() {}, retry() {}, force() {}, relayOnly() {}, report: async () => {},
                status: () => ({ state: "off" }) };

// ctx: {role, conn, playerId, name, host: "local"|"pages", origin, build, kind, isPublic(id, item?),
//       pcTokens: Set, settings, fx_ok, log(text), onHeartbeat(hb), onStatus(),
//       relayOnly: bool (the Pages copy draws on this tab), sameTab: {kind, build, fx_ok, host} | null
//       (what the other copy of the extension on this tab said in its HELLO)}
// mods: {fx, aim, rings, geometry, jobs: {op: fn(job)}, summary(), fetchImpl, timers}
export function startBridge(api, ctx, mods = {}) {
  if (ctx.role !== "GM") return inert; // players never talk to the panel
  const OBR = api.OBR;
  const T = mods.timers || defaultTimers;
  const fetchImpl = mods.fetchImpl || ((url, opts) => fetch(url, opts));
  const log = ctx.log || (() => {});
  const conn = ctx.conn;
  setConnection(conn);

  let state = "off"; // off | finding | no-panel | standby | bridge | legacy | stopped
  let base = null;
  let holder = null;
  let holderRoom = { id: "", name: "" }; // the bridge tab's Owlbear room, as the panel said
  let reason = "";
  let lastPanelOk = 0;
  let lastReportAt = 0;
  let lastRelease = -Infinity; // when the panel last forgot the lease (restarted)
  let run = 0; // which job loop is current
  let findTimer = null, standbyTimer = null, hbTimer = null;
  let party = [];
  let roster = {}; // player id -> entry
  let rosterRev = null;
  const screens = new Map(); // connection -> what its HELLO said
  const handled = new Set(); // aim ids already locked (or cancelled) through here
  const aims = new Map(); // aim id -> the AimSpec the panel sent (range, caster), newest last
  const AIMS_KEPT = 20;

  const enc = encodeURIComponent;
  // Which Owlbear room this tab is in, for the lease and every map report, so the panel can tell
  // a tab left open in another room (TheCozyBooze) from the game room's: OBR.room.id (from the
  // obrref Owlbear loaded this page with), and the room's name when the referrer has it.
  const roomId = () => {
    try { return String(OBR.room.id ?? ""); } catch { return ""; }
  };
  const roomName = () => {
    try { return roomNameOf(globalThis.document?.referrer); } catch { return ""; }
  };
  const isBridge =() => state === "bridge" || state === "legacy";
  // On the Pages site only through the popover's Advanced override: Chrome stops a Pages copy
  // reaching this PC's panel (probe P2), so the Dell's bridge is the copy the panel serves.
  const optedIn = () => ctx.host === "local" || lsGet(LS.BRIDGE_HERE) === "1";
  const relayOnly = () => !!ctx.relayOnly; // a Pages copy on this tab draws; this copy only relays
  const out = (dest) => (relayOnly() && dest === "REMOTE" ? "ALL" : dest); // reach this tab's Pages copy too
  // The screen this tab is: in relay-only mode the Pages copy here does the drawing, so its
  // HELLO (build, effects ready or not) describes this tab's screen, not this copy.
  const drawer = () => (relayOnly() && ctx.sameTab ? ctx.sameTab
    : { kind: ctx.kind || "gm", build: ctx.build || "dev", fx_ok: !!ctx.fx_ok, host: ctx.host });
  const gmNote = (text) => send(api, CH.NOTE, { audience: "gm", text, variant: "WARNING" }, "ALL");
  const sleep = (ms) => new Promise((resolve) => T.setTimeout(resolve, ms));
  const changed = () => { try { ctx.onStatus?.(); } catch { /* the popover's problem */ } };

  function timedFetch(url, opts = {}, ms) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    return new Promise((resolve, reject) => {
      const t = T.setTimeout(() => {
        try { ac?.abort(); } catch { /* already done */ }
        reject(new Error(`timed out: ${url}`));
      }, ms);
      Promise.resolve()
        .then(() => fetchImpl(url, ac ? { ...opts, signal: ac.signal } : opts))
        .then((r) => { T.clearTimeout(t); resolve(r); }, (e) => { T.clearTimeout(t); reject(e); });
    });
  }

  async function post(path, body) {
    try {
      const r = await timedFetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, 8000);
      lastPanelOk = T.now();
      let j = null;
      try { j = await r.json(); } catch { /* 204 or not JSON */ }
      if (!r.ok) return { ok: false, status: r.status, error: j?.error || `the panel answered ${r.status}` };
      return j ?? { ok: true };
    } catch (e) {
      return { ok: false, error: "the DND panel isn't answering" };
    }
  }

  // ---- finding the panel and holding the lease ----

  async function probe(b) {
    const r = await timedFetch(`${b}/api/map/hello`, {}, HELLO_TIMEOUT_MS);
    const j = await r.json();
    if (j?.app !== "dnd-npc") throw new Error("not the DND panel");
    return b;
  }

  async function findPanel() {
    if (ctx.host === "local") return ctx.origin; // the panel serves this very page
    const cached = lsGet(LS.PANEL_BASE);
    if (cached) {
      try { return await probe(cached); } catch { /* moved or stopped: scan */ }
    }
    try {
      const found = await Promise.any(PANEL_PORTS.map((p) => probe(`http://localhost:${p}`)));
      lsSet(LS.PANEL_BASE, found);
      return found;
    } catch {
      return null;
    }
  }

  function clearTimers() {
    for (const t of [findTimer, standbyTimer]) if (t) T.clearTimeout(t);
    if (hbTimer) T.clearInterval(hbTimer);
    findTimer = standbyTimer = hbTimer = null;
    run++; // any job loop still waiting ends when it wakes
  }

  async function find() {
    if (state === "stopped") return;
    clearTimers();
    if (!optedIn()) {
      state = "off";
      reason = "This copy never talks to the DND panel. On the Dell, the “DND NPC (this PC)” copy "
        + "(served by the panel) is the bridge.";
      changed();
      return;
    }
    state = "finding";
    reason = "";
    changed();
    const found = await findPanel();
    if (state !== "finding") return; // stopped or forced meanwhile
    if (!found) {
      state = "no-panel";
      reason = "No DND panel on this PC's localhost:7420-7429. Is the voice system running? "
        + "If Chrome asked about devices on your local network, click Allow.";
      findTimer = T.setTimeout(find, FIND_RETRY_MS);
      changed();
      return;
    }
    base = found;
    await lease(false);
  }

  async function lease(force) {
    if (state === "stopped" || !base) return;
    if (standbyTimer) T.clearTimeout(standbyTimer);
    standbyTimer = null;
    const q = `conn=${enc(conn)}&build=${enc(ctx.build || "dev")}&host=${ctx.host}`
      + `&room=${enc(roomId())}&room_name=${enc(roomName())}${force ? "&force=1" : ""}`;
    let r, j = null;
    try {
      r = await timedFetch(`${base}/api/map/hello?${q}`, {}, 5000);
      if (r.ok) j = await r.json();
    } catch {
      r = null;
    }
    if (state === "stopped") return;
    if (r && r.ok) lastPanelOk = T.now();
    if (ctx.host === "local" && (r?.status === 404 || (j && j.bridge === undefined))) {
      becomeLegacy(); // a panel from before Step 36: the old 1 s loop
      return;
    }
    if (!j) {
      clearTimers();
      state = "no-panel";
      reason = r ? `The DND panel answered ${r.status}.` : "The DND panel isn't answering.";
      findTimer = T.setTimeout(find, STANDBY_RETRY_MS);
      changed();
      return;
    }
    fromServer(j);
    holder = j.holder ?? null;
    holderRoom = { id: String(j.holder_room || ""), name: String(j.holder_room_name || "") };
    if (j.bridge) becomeBridge();
    else becomeStandby();
  }

  function becomeBridge() {
    if (state === "bridge") return;
    clearTimers();
    state = "bridge";
    reason = "";
    log(`bridge: this tab is the bridge (${base})`);
    setSceneWrite(api, conn, sceneWanted());
    heartbeat();
    hbTimer = T.setInterval(heartbeat, HEARTBEAT_MS);
    report();
    loop(run, false);
    changed();
  }

  function becomeLegacy() {
    clearTimers();
    state = "legacy";
    reason = "This panel is from before Step 36 (no lease): running the old map loop.";
    log("bridge: older panel, legacy loop");
    heartbeat();
    hbTimer = T.setInterval(heartbeat, HEARTBEAT_MS);
    report();
    loop(run, true);
    changed();
  }

  function becomeStandby() {
    clearTimers();
    state = "standby";
    // The bridge in another room than this tab's: either may be the game's (TheCozyBooze left open,
    // or this is it), so the "Make this tab the bridge" hint says when to tap it.
    const label = roomLabel(holderRoom.id, holderRoom.name);
    const here = roomId();
    const elsewhere = !!holderRoom.id && !!here && holderRoom.id !== here;
    reason = holder ? `Another tab is the bridge${label ? `, in ${label}` : ""}.`
        + (elsewhere ? " If the game is in this room, tap “Make this tab the bridge”." : "")
      : "The panel picked another tab.";
    standbyTimer = T.setTimeout(() => lease(false), STANDBY_RETRY_MS);
    changed();
  }

  function fromServer(j) {
    if (j.settings && typeof j.settings === "object") setSettings(j.settings, false);
    if (Array.isArray(j.pc_tokens)) setPcTokens(j.pc_tokens);
  }

  // ---- the job loop ----

  async function loop(me, legacy) {
    let errors = 0;
    while (me === run && isBridge()) {
      const started = T.now();
      let body;
      try {
        const url = legacy ? `${base}/api/map/todo` : `${base}/api/map/todo?conn=${enc(conn)}&wait=${LONG_POLL_S}`;
        const r = await timedFetch(url, {}, (LONG_POLL_S + 10) * 1000);
        if (!r.ok) throw new Error(`todo answered ${r.status}`);
        body = await r.json();
        errors = 0;
        lastPanelOk = T.now();
      } catch (e) {
        if (me !== run) return;
        if (++errors >= ERRORS_BEFORE_FIND) {
          log("bridge: the panel stopped answering; looking for it again");
          find();
          return;
        }
        await sleep(ERROR_RETRY_MS);
        continue;
      }
      if (me !== run) return;
      let jobs;
      if (Array.isArray(body)) jobs = body; // the old bare list
      else if (body && body.bridge === false) {
        holder = body.holder ?? null;
        holderRoom = { id: "", name: "" }; // the job loop's answer doesn't say which room; the next hello does
        if (!holder && T.now() - lastRelease > STANDBY_RETRY_MS) {
          // Nobody holds it (the panel restarted): ask for the lease again now, not in 10 s.
          lastRelease = T.now();
          clearTimers();
          state = "finding";
          lease(false);
          return;
        }
        becomeStandby(); // the panel gave the lease to another tab
        return;
      } else {
        jobs = Array.isArray(body?.jobs) ? body.jobs : [];
        if (Array.isArray(body?.pc_tokens) && setPcTokens(body.pc_tokens)) heartbeat(); // the screens hear it now
      }
      await runJobs(jobs);
      if (T.now() - lastReportAt > REPORT_EVERY_MS) report();
      if (legacy || Array.isArray(body) || (!jobs.length && T.now() - started < QUICK_EMPTY_MS)) {
        await sleep(LEGACY_POLL_MS);
      }
    }
  }

  async function runJobs(jobs) {
    for (const job of jobs) {
      try {
        await dispatch(job);
      } catch (e) {
        console.warn("dnd-npc map job failed", job, e);
      }
    }
  }

  async function dispatch(job) {
    const old = mods.jobs?.[job?.op];
    if (old) return old(job); // hp stats mark ping unring down cond: the functions from game night 1
    switch (job?.op) {
      case "fx": return playFx(job);
      case "aim":
        if (job.aim?.id != null) {
          aims.delete(String(job.aim.id));
          aims.set(String(job.aim.id), job.aim);
          while (aims.size > AIMS_KEPT) aims.delete(aims.keys().next().value);
        }
        return send(api, CH.AIM_START, { audience: "gm", aim: job.aim }, "ALL");
      case "aim-show": {
        const { op, ...show } = job;
        if (show.audience !== "gm") delete show.secret; // never hidden ids in the public copy
        return send(api, CH.AIM_SHOW, show, "ALL");
      }
      case "aim-clear": return send(api, CH.AIM_CLEAR, { id: job.id, fade_ms: job.fade_ms ?? 300 }, "ALL");
      case "aim-cancel": return send(api, CH.AIM_CANCEL, { audience: "gm", id: job.id }, "ALL");
      case "ring":
        if (!mods.rings?.setTargetRings) return;
        return mods.rings.setTargetRings(api, job.ids || [], { replace: job.replace !== false, color: job.color || TARGET_COLOR });
      case "owner": return setOwner(job.token, job.player);
      case "show_pcs": return showPcs(job.ids);
      case "zones":
        return mods.fx?.zones?.sync?.(Array.isArray(job.zones) ? job.zones : []);
      case "roster": return setRoster(job);
      case "cast-status":
        return send(api, CH.CAST_STATUS, { to: job.to, req: job.req, status: job.status, note: job.note || "" }, out("REMOTE"));
      case "settings": return setSettings(job.settings || {}, true);
      case "note":
        return send(api, CH.NOTE, { audience: job.audience || "all", text: String(job.text || ""), variant: job.variant || "DEFAULT" }, "ALL");
      default:
        return undefined; // an op this build doesn't know: ignored, like the old extension did
    }
  }

  function playFx(job) {
    const pub = job.public || null, gm = job.gm || null;
    const full = mergeEvents(pub, gm);
    if (full && mods.fx && !relayOnly()) {
      try {
        Promise.resolve(mods.fx.play(full)).catch((e) => console.warn("dnd-npc fx failed", e));
      } catch (e) {
        console.warn("dnd-npc fx failed", e);
      }
    }
    if (pub) send(api, CH.FX, { audience: "all", event: pub }, out("REMOTE"));
    if (gm) send(api, CH.FX, { audience: "gm", event: gm }, out("REMOTE"));
  }

  async function setOwner(token, player) {
    // A player linked to a character on the Party spells page owns its token (and what's
    // attached to it), so they can move it; the token is shown so they can see it.
    if (!token || !player) return;
    const items = await OBR.scene.items.getItemAttachments([token]);
    const ids = items.map((i) => i.id);
    if (!ids.includes(token)) return; // not on this map
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const d of drafts) {
        d.createdUserId = player;
        if (d.id === token || (d.attachedTo === token && d.metadata?.[RING_KEY]?.enabled)) d.visible = true;
      }
    });
  }

  async function showPcs(ids) {
    // 👁 Show PC tokens: every party token (and its Colored Rings rings) visible to the players.
    const list = Array.isArray(ids) && ids.length ? ids : [...ctx.pcTokens];
    if (!list.length) return;
    const items = await OBR.scene.items.getItemAttachments(list);
    const hidden = items.filter((i) => i.visible === false
      && (list.includes(i.id) || (list.includes(i.attachedTo) && i.metadata?.[RING_KEY]?.enabled))).map((i) => i.id);
    if (!hidden.length) return;
    await OBR.scene.items.updateItems(hidden, (drafts) => {
      for (const d of drafts) d.visible = true;
    });
  }

  function setRoster(job) {
    const next = {};
    for (const [pid, v] of Object.entries(job.players || {})) {
      next[pid] = v && typeof v === "object" && "entry" in v && "to" in v ? v.entry : v;
    }
    rosterRev = job.rev ?? rosterRev;
    for (const pid of Object.keys(roster)) if (!(pid in next)) sendRoster(pid, null); // unlinked
    roster = next;
    for (const pid of Object.keys(next)) sendRoster(pid, next[pid]);
  }

  function sendRoster(pid, entry) {
    if (!send(api, CH.ROSTER, { to: pid, entry, rev: rosterRev }, out("REMOTE"))) {
      // Over bus.MAX_BYTES: the player's popover would just never show their spells. Tell the DM.
      const who = entry?.character || party.find((p) => p.id === pid)?.name || "A player";
      log(`bridge: ${pid}'s spell list is too big to send`);
      gmNote(`📖 ${who}'s spell list is too big to send to their device. Trim it on the Party spells page.`);
    }
  }

  function setSettings(s, announce) {
    ctx.settings = { ...DEFAULT_SETTINGS, ...s, quality: { ...DEFAULT_SETTINGS.quality, ...(s.quality || {}) } };
    if (isBridge()) setSceneWrite(api, conn, sceneWanted());
    if (announce) heartbeat(); // every screen hears it now, not in 5 s
  }

  // Returns whether the set changed.
  function setPcTokens(list) {
    const next = new Set(list.filter((id) => typeof id === "string" && id));
    if (next.size === ctx.pcTokens.size && [...next].every((id) => ctx.pcTokens.has(id))) return false;
    ctx.pcTokens.clear();
    for (const id of next) ctx.pcTokens.add(id);
    return true;
  }

  const sceneWanted = () => lsGet(LS.SCENE_BUS) === "1" || ctx.settings?.scene_bus === true;

  // ---- heartbeat and the map report ----

  function heartbeat() {
    if (!isBridge()) return;
    const hb = {
      conn, build: ctx.build || "dev", panel: T.now() - lastPanelOk < PANEL_DOWN_MS ? "ok" : "down",
      fx_ok: !!drawer().fx_ok, at: T.now(), settings: ctx.settings || DEFAULT_SETTINGS, pc_tokens: [...ctx.pcTokens],
      ...(sceneWanted() ? { scene_bus: true } : {}),
    };
    send(api, CH.BRIDGE, hb, out("REMOTE"));
    try { ctx.onHeartbeat?.(hb, { self: true }); } catch (e) { console.warn("dnd-npc heartbeat", e); }
  }

  async function extras() {
    const now = T.now();
    for (const [c, s] of screens) if (now - s.at > SCREEN_GONE_MS) screens.delete(c);
    const d = drawer();
    const self = { connection: conn, player_id: ctx.playerId, name: ctx.name || "", role: ctx.role, kind: d.kind || "gm",
                   build: d.build || "dev", fx_ok: !!d.fx_ok, host: d.host || ctx.host, at: now };
    return {
      room: { id: roomId(), name: roomName() }, // which Owlbear room this map is (map_state.obr_room)
      me: { id: ctx.playerId, name: ctx.name || "", connection: conn },
      players: party.map((p) => ({ id: p.id, name: p.name, role: p.role, connection: p.connectionId })),
      screens: [self, ...[...screens.values()].filter((s) => s.connection !== conn)],
    };
  }

  async function report() {
    // The map as it is now, to the panel. Only the tab holding the lease reports (a standby
    // tab does nothing), and nothing here waits on or throttles a report (R8).
    if (!isBridge() || !mods.summary) return;
    lastReportAt = T.now();
    try {
      const body = { ...(await mods.summary()), ...(await extras()) };
      const url = state === "legacy" ? `${base}/api/map` : `${base}/api/map?conn=${enc(conn)}`;
      const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r?.ok) {
        lastPanelOk = T.now();
        // The panel answers with which tokens are PCs now that it has seen this map (the lease
        // was given before the first report): the screens hear it at once, not after the next
        // long poll (R1: a hidden PC is public on every screen).
        let j = null;
        try { j = await r.json(); } catch { /* 204, or an older panel's plain answer */ }
        if (Array.isArray(j?.pc_tokens) && setPcTokens(j.pc_tokens)) heartbeat();
      }
    } catch (e) {
      // The voice system isn't running: try again on the next change or heartbeat.
    }
  }

  // ---- what the other screens send up ----

  async function playerOf(connectionId) {
    // Who sent it, by the connection Owlbear stamped on the message, never by its contents.
    if (!connectionId) return null;
    if (connectionId === conn) return { id: ctx.playerId, name: ctx.name || "", role: ctx.role, connectionId };
    let p = party.find((x) => x.connectionId === connectionId);
    if (!p) {
      try { party = (await OBR.party.getPlayers()) || []; } catch { /* keep the old list */ }
      p = party.find((x) => x.connectionId === connectionId);
    }
    return p ? { id: p.id, name: p.name, role: p.role, connectionId } : null;
  }

  async function gridNow() {
    const scale = await OBR.scene.grid.getScale();
    return {
      dpi: await OBR.scene.grid.getDpi(), multiplier: scale?.parsed?.multiplier ?? 5, unit: scale?.parsed?.unit ?? "ft",
      measurement: await OBR.scene.grid.getMeasurement(), type: await OBR.scene.grid.getType(),
    };
  }

  async function caughtBy(template, target) {
    // Every token the template catches, hidden ones included (marked secret), nearest first.
    // caught is null when it can't be worked out (the aim module didn't load here, or broke):
    // never an empty list, which would wipe every BLUE ring on the map (R4, R10).
    const items = await OBR.scene.items.getItems();
    const grid = await gridNow();
    if (template) {
      if (!mods.geometry?.computeCaught) return { caught: null, items, grid };
      const got = await mods.geometry.computeCaught(template, items, grid,
        { includeSecret: true, isPublic: ctx.isPublic, casterId: template.caster_token || null });
      if (!Array.isArray(got)) return { caught: null, items, grid };
      return { caught: got.map((c) => ({ id: c.id, secret: !!c.secret })), items, grid };
    }
    if (target) {
      const item = items.find((i) => i.id === target);
      return { caught: [{ id: target, secret: !ctx.isPublic(target, item) }], items, grid };
    }
    return { caught: [], items, grid };
  }

  // How far the caster is from where the spell lands (the template's origin, or the target
  // token), and whether that's past its range: for the panel's "⚠ too far". got = caughtBy(...).
  function measure(got, casterId, template, target, rangeFt) {
    const caster = casterId ? got?.items?.find((i) => i.id === casterId) : null;
    if (!caster || !got?.grid) return { feet: null, outOfRange: false };
    const a = footprint(caster, got.grid.dpi);
    const t = target ? got.items.find((i) => i.id === target) : null;
    const o = template?.origin;
    const feet = t ? feetBetween(a, footprint(t, got.grid.dpi), got.grid, { tokens: true })
      : o && Number.isFinite(o.x) && Number.isFinite(o.y) ? feetBetween(a, { l: o.x, t: o.y, r: o.x, b: o.y }, got.grid)
        : null;
    return { feet, outOfRange: feet != null && rangeFt > 0 && feet > rangeFt };
  }

  // Upstream messages only count when Owlbear itself says who sent them. The scene-metadata
  // fallback names its sender in a key any client can write, so it never reaches these.
  const trusted = (ev) => !!ev?.connectionId && !ev.viaScene;

  async function onAimLocked(msg, ev) {
    if (!isBridge() || !msg?.aim_id || !trusted(ev)) return;
    const who = await playerOf(ev.connectionId);
    if (who?.role !== "GM") return;
    // The first lock wins: the other GM aimers' copies are ignored, and so is an Esc that a
    // slower GM screen sends after this aim was locked (it would cancel the locked aim).
    if (msg.cancel && handled.has(`${msg.aim_id}:lock`)) return;
    const key = `${msg.aim_id}:${msg.cancel ? "cancel" : "lock"}`;
    if (handled.has(key)) return;
    handled.add(key);
    if (msg.cancel) {
      await post("/api/map/aim", { aim_id: msg.aim_id, template: null, caught: [], cancel: true });
      return;
    }
    let caught = null, got = null;
    try {
      got = await caughtBy(msg.template || null, msg.target || null);
      caught = got.caught;
    } catch (e) {
      console.warn("dnd-npc: couldn't work out who the aim caught", e);
    }
    if (!Array.isArray(caught)) {
      // Fail closed: the rings and the panel's targets stay as they are; the DM marks by hand.
      log("bridge: couldn't work out who the template caught; rings left as they were");
      gmNote("🎯 Couldn't work out who that template caught (the aim module failed on the Dell). "
        + "The rings are as they were: mark the targets by hand.");
      return;
    }
    // Rings first, then the panel: a map report already on its way can't undo the targets (F6).
    if (mods.rings?.setTargetRings && (msg.template || msg.target)) {
      try {
        await mods.rings.setTargetRings(api, caught.map((c) => c.id), { replace: true });
      } catch (e) {
        console.warn("dnd-npc: couldn't ring the targets", e);
      }
    }
    // How far, for the panel's "⚠ too far": the aim tool on the aimer's screen measured it; an
    // aimer from an older build that didn't send it is measured here, from the panel's AimSpec.
    let feet = Number.isFinite(msg.feet) ? Math.round(msg.feet) : null;
    let outOfRange = msg.out_of_range === true;
    if (!("feet" in msg) && got) {
      try {
        const spec = aims.get(String(msg.aim_id));
        ({ feet, outOfRange } = measure(got, msg.template?.caster_token || spec?.caster_token || null,
                                        msg.template, msg.target, +spec?.range_ft || 0));
      } catch (e) {
        console.warn("dnd-npc: couldn't measure the aim", e);
      }
    }
    await post("/api/map/aim", { aim_id: msg.aim_id, template: msg.template || null, caught, feet, out_of_range: outOfRange,
                                 ...(msg.target ? { target: msg.target } : {}) });
  }

  async function onCastRequest(msg, ev) {
    if (!isBridge() || !msg?.req || !trusted(ev)) return;
    const who = await playerOf(ev.connectionId);
    if (!who) return log("bridge: a cast request from someone not in the room, ignored");
    if (msg.player_id && msg.player_id !== who.id) {
      return log(`bridge: a cast request claiming to be from ${msg.player_id} came from ${who.name}; ignored`);
    }
    if (ctx.settings?.player_casts === false) {
      send(api, CH.CAST_STATUS, { to: who.id, req: msg.req, status: "declined", note: "The DM is taking casts by voice tonight" }, out("REMOTE"));
      return;
    }
    let caught = null, feet = null, outOfRange = false;
    try {
      const got = await caughtBy(msg.template || null, msg.target || null);
      caught = got.caught;
      if (!Array.isArray(caught)) throw new Error("the aim module can't measure templates here");
      const entry = roster[who.id];
      const item = (entry?.items || []).find((i) => i.key === msg.key);
      ({ feet, outOfRange } = measure(got, entry?.token || null, msg.template, msg.target, +item?.range_ft || 0));
    } catch (e) {
      console.warn("dnd-npc: couldn't measure the cast request", e);
    }
    if (!Array.isArray(caught)) {
      // Who the area catches is unknown: accepting it would ring nobody and wipe the DM's rings.
      send(api, CH.CAST_STATUS, { to: who.id, req: msg.req, status: "error",
                                  note: "The DM's map can't measure that area right now. Tell the DM what you're casting." },
           out("REMOTE"));
      gmNote(`🙋 ${who.name || "A player"}'s cast request couldn't be measured (the aim module failed on the Dell).`);
      return;
    }
    const r = await post("/api/map/cast-request", {
      req: msg.req, player_id: who.id, player_name: who.name, character: msg.character, key: msg.key,
      template: msg.template || null, target: msg.target || null, caught, out_of_range: outOfRange, feet,
    });
    if (r?.ok === false) {
      send(api, CH.CAST_STATUS, { to: who.id, req: msg.req, status: "error", note: r.error || "The panel didn't take it" }, out("REMOTE"));
    }
  }

  async function onCastWithdraw(msg, ev) {
    if (!isBridge() || !msg?.req || !trusted(ev)) return;
    const who = await playerOf(ev.connectionId);
    if (!who) return;
    await post("/api/map/cast-withdraw", { player_id: who.id, req: msg.req });
  }

  async function onRpc(msg, ev) {
    // The 🗺 menus and the map check of a GM screen that can't reach the panel itself. The
    // answers name the adventure's places and NPCs (hidden ones too), so they never go over the
    // air in the clear (R2): the other copy of the extension on this very tab (the Dell's Pages
    // copy, same connection) is answered LOCAL, which never leaves this PC; any other GM device
    // (the laptop) gets the answer sealed with the one-time key it sent (bus.js).
    if (!isBridge() || !msg?.id || !trusted(ev)) return;
    const who = await playerOf(ev.connectionId);
    if (who?.role !== "GM") return; // the menus are the GM's
    const here = ev.connectionId === conn;
    const key = typeof msg.key === "string" && msg.key ? msg.key : null;
    // LOCAL never reaches the OTHER extension's frames on this tab (seen live 2026-10-06: the
    // Pages copy's map check and 🗺 menus timed out), so a same-tab asker that sent a key gets
    // the sealed answer over ALL like any other GM device. LOCAL only when there's no key.
    const localOnly = here && !key;
    const dest = localOnly ? "LOCAL" : "ALL";
    const reply = (status, extra = {}) => send(api, CH.RPC_REPLY, { audience: "gm", id: msg.id, status, ...extra }, dest);
    if (!RPC_PATHS.includes(msg.path)) return reply(403);
    if (!here && !key && msg.path === "/api/map/catalog") return reply(403, { error: CATALOG_IN_CLEAR });
    let r, body;
    try {
      r = await timedFetch(base + msg.path, {}, 4000);
      body = await r.json();
    } catch {
      return reply(502);
    }
    if (localOnly) {
      if (!reply(r.status, { body })) reply(413);
      return;
    }
    if (key && canSeal()) {
      let sealed;
      try {
        sealed = await seal(body, key, msg.id);
      } catch (e) {
        console.warn("dnd-npc: couldn't seal the answer", e);
        return reply(400, { error: "The bridge couldn't use this device's key." });
      }
      if (!reply(r.status, { sealed })) reply(413);
      return;
    }
    // No key (an older build, or no WebCrypto on that device), or none here: only what's safe
    // for every device to see. The catalog was refused above.
    if (msg.path !== "/api/map/check") return reply(403, { error: CATALOG_IN_CLEAR });
    if (!reply(r.status, { body: checkForRpc(body) })) reply(413);
  }

  async function onHello(msg, ev) {
    // Another screen says who it is: the panel's screens list, and its roster or a heartbeat.
    // This tab's own hellos (and the other copy of the extension on this tab, whose HELLO
    // background.js keeps in ctx.sameTab) are this screen, reported as `self`.
    const c = ev?.connectionId;
    if (!trusted(ev) || ev.local) return;
    const who = c === conn ? null : await playerOf(c);
    if (c !== conn) {
      const prev = screens.get(c) || {};
      screens.set(c, {
        connection: c, player_id: who?.id ?? prev.player_id ?? null, name: who?.name ?? prev.name ?? "",
        role: who?.role ?? msg.role ?? prev.role ?? "", kind: msg.kind ?? prev.kind ?? "",
        build: msg.build ?? prev.build ?? "", fx_ok: msg.fx_ok ?? prev.fx_ok ?? false, host: msg.host ?? prev.host ?? "",
        at: T.now(),
      });
    }
    if (!isBridge()) return;
    const need = Array.isArray(msg.need) ? msg.need : [];
    if (need.includes("roster") && who && who.id in roster) sendRoster(who.id, roster[who.id]);
    if (need.includes("bridge")) heartbeat();
  }

  function goRelayOnly() {
    // The Pages copy of the extension runs on this same tab (the dual install): it draws the
    // effects and opens the aim tool, and this copy only relays for it. Say so at once, so the
    // Pages copy hears the bridge now rather than in 5 s.
    const was = relayOnly();
    ctx.relayOnly = true;
    if (was) return;
    log("bridge: the Pages copy is on this tab too; this copy only relays");
    heartbeat();
    changed();
  }

  const offs = [
    on(api, CH.HELLO, onHello),
    on(api, CH.AIM_LOCKED, onAimLocked),
    on(api, CH.CAST_REQUEST, onCastRequest),
    on(api, CH.CAST_WITHDRAW, onCastWithdraw),
    on(api, CH.RPC, onRpc),
  ];
  try {
    OBR.party.getPlayers().then((p) => { party = p || []; }, () => {});
    const off = OBR.party.onChange((p) => {
      party = p || [];
      const live = new Set(party.map((x) => x.connectionId));
      for (const c of screens.keys()) if (c !== conn && !live.has(c)) screens.delete(c);
    });
    if (typeof off === "function") offs.push(off);
  } catch (e) {
    console.warn("dnd-npc: no party list", e);
  }

  find();

  return {
    isBridge,
    stop() {
      clearTimers();
      state = "stopped";
      for (const off of offs) try { off(); } catch { /* gone */ }
      setSceneWrite(api, conn, false);
    },
    retry() {
      if (!optedIn()) {
        // Unticked "🖥 This PC runs the DND panel": stop being the bridge (the lease lapses in 20 s).
        if (state !== "off" && state !== "stopped") find();
        return;
      }
      if (isBridge()) setSceneWrite(api, conn, sceneWanted()); // the popover's fallback box may have changed
      if (state === "bridge" || state === "legacy" || state === "finding") return;
      find();
    },
    async force() {
      // "Make this tab the bridge": take the lease even from a live tab.
      if (!optedIn()) return find();
      if (!base) base = await findPanel();
      if (!base) return find();
      clearTimers();
      state = "finding";
      await lease(true);
    },
    relayOnly: goRelayOnly,
    report,
    heartbeat,
    status: () => ({
      state, base, holder, reason, relayOnly: relayOnly(), opted_in: optedIn(),
      panel: T.now() - lastPanelOk < PANEL_DOWN_MS ? "ok" : "down",
      screens: screens.size, roster: Object.keys(roster).length,
    }),
  };
}
