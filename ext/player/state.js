// A player's side of casting from their phone (or laptop): their list of spells and attacks,
// aiming one, sending the request to the DM and following what the DM decides. It lives in
// the background frame (background.js creates it on PLAYER screens); the popover
// (player.html) only shows its snapshot and asks it to do things.
//
//   createPlayerState(api, ctx, {aim, send, on?, storage?, now?, CH?})
//     -> {ready, onRoster, onStatus, onBridge, snapshot(), startFromPopover(item|key),
//         onLocked(result, info?), withdraw(req?), handleAsk(msg), hello(), stop()}
//
//   api   {OBR}                  ctx  {role, playerId, connectionId, kind, build, fx_ok, log}
//   aim   the aim tool (aim/tool.js installAim)
//   send  (channel, data, dest "REMOTE"|"LOCAL"|"ALL") -> bool: bus.js's send, bound to api;
//         without it OBR.broadcast is used directly
//   on    (channel, fn) -> unsubscribe: bus.js's on; without it OBR.broadcast.onMessage
//
// The background hands over the bridge's messages (onRoster, onStatus, onBridge) after its
// own audience check; onRoster takes the ROSTER message, or (entry, message). An entry of null
// means the DM unlinked this player. The list is cached for a reload, but a cached list is
// checked with the bridge again and dropped when the bridge has none for us.
// This module listens to one channel itself: LOCAL_ASK from its popover ({need: "state"} /
// {need: "aim", key} / {need: "withdraw", req}), and answers with LOCAL_STATE.
import { CH as DEFAULT_CH, LS_ROSTER } from "../aim/consts.js?v=842f61f";
import { logText } from "../aim/geometry.js?v=842f61f";
import { specFor } from "./view.js?v=842f61f";

const STATUSES = ["waiting", "accepted", "declined", "told", "error"];
// Which DM decisions can follow which (anything else is a late or repeated message).
const NEXT = {
  waiting: new Set(["waiting", "accepted", "declined", "told", "error"]),
  accepted: new Set(["told", "declined", "error"]),
  error: new Set(["waiting", "accepted", "declined", "told"]),
  declined: new Set(),
  told: new Set(),
  withdrawn: new Set(),
};
const HELLO_EVERY_MS = 10000; // ask the bridge for the roster again at most this often while we have none
const BRIDGE_FRESH_MS = 20000;
// The bridge answers a HELLO at once when this player is linked. A cached list that the bridge
// heard us ask about and didn't resend this long after is out of date (we were unlinked).
const NO_ROSTER_MS = 4000;

const unwrap = (x, field) => (x && typeof x === "object" && !(field in x) && x.data && typeof x.data === "object" ? x.data : x);

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function cleanEntry(e) {
  // Keep only what the list needs (names and numbers), whatever else arrived.
  if (!e || typeof e !== "object") return null;
  const items = (Array.isArray(e.items) ? e.items : []).filter((i) => i && typeof i.key === "string").map((i) => ({
    key: i.key, name: String(i.name ?? i.key), group: i.group ?? null, kind: i.kind === "attack" ? "attack" : "spell",
    mode: i.mode ?? null, range_ft: i.range_ft ?? null, long_ft: i.long_ft ?? null, area: i.area ?? null,
    color: i.color ?? null, label: i.label ?? "", save_label: i.save_label ?? "", conc: !!i.conc,
    // whether "you" is a target: the roster's own say when it has one (view.js selfOk)
    self_ok: typeof i.self_ok === "boolean" ? i.self_ok : null, target: typeof i.target === "string" ? i.target : null,
  }));
  return { character: e.character ? String(e.character) : null, token: e.token || null, rev: e.rev ?? null,
           player_casts: e.player_casts !== false, items };
}

export function createPlayerState(api = {}, ctx = {}, deps = {}) {
  const OBR = api.OBR;
  const CH = { ...DEFAULT_CH, ...(deps.CH || {}) };
  const aim = deps.aim || null;
  const now = deps.now || (() => Date.now());
  const storage = "storage" in deps ? deps.storage : safeStorage();
  const log = (...a) => {
    // background.js's ctx.log takes one line of text (and adds "dnd-npc "); the console takes anything.
    try {
      if (ctx.log) ctx.log(`player: ${a.map(logText).join(" ")}`);
      else console.warn("dnd-npc player:", ...a);
    } catch {
      // nothing to do
    }
  };
  const send = (ch, data, dest = "REMOTE") => {
    try {
      data = { v: 1, ...data }; // every broadcast carries its version (spec section 7)
      if (deps.send) return deps.send(ch, data, dest) !== false;
      const p = OBR?.broadcast?.sendMessage(ch, data, { destination: dest });
      if (p && typeof p.catch === "function") p.catch((e) => log("send failed", ch, e));
      return !!p;
    } catch (e) {
      log("send failed", ch, e);
      return false;
    }
  };

  let me = ctx.playerId || null;
  let conn = ctx.connectionId || null;
  let entry = null;
  let fresh = false; // the entry came from the bridge this session (not just from the cache)
  let asked = null; // {conn, at}: the last HELLO sent while that bridge was beating
  let bridge = null; // {conn, at, player_casts}
  let request = null; // {req, key, name, status, note, template, target, at}
  let aiming = null; // {id, key, name, spec}
  let n = 0;
  let lastHello = -Infinity;
  let lastSnap = "";
  const handled = new Set(); // aim ids already turned into a request
  const offs = [];

  const cacheKey = () => (me ? LS_ROSTER + me : null);
  function readCache() {
    try {
      const raw = cacheKey() && storage?.getItem(cacheKey());
      return raw ? cleanEntry(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
  function writeCache() {
    try {
      if (cacheKey() && entry) storage?.setItem(cacheKey(), JSON.stringify(entry));
    } catch {
      // private window: the bridge sends it again
    }
  }
  function dropCache() {
    try {
      if (cacheKey()) storage?.removeItem?.(cacheKey());
    } catch {
      // nothing stored
    }
  }

  function setEntry(e, { isFresh }) {
    entry = e;
    fresh = isFresh;
    try {
      aim?.setOwnTokens?.(entry?.token ? [entry.token] : []); // my own PC token is public on my screen
    } catch (err) {
      log("own token not passed on", err);
    }
  }

  function forget(why) {
    // Not linked (any more): drop the list and its cached copy, so the popover says "Ask the
    // DM to link you" and no tap sends a request the DM's side would refuse.
    if (!entry && !fresh) return;
    log("roster dropped:", why);
    setEntry(null, { isFresh: false });
    dropCache();
    if (aiming) {
      try {
        aim?.cancel?.(aiming.id); // an aim from the old list would lead nowhere
      } catch {
        // already over
      }
      aiming = null;
    }
  }

  const castsOn = () => !!entry && entry.player_casts !== false && bridge?.player_casts !== false;

  function snapshot() {
    return {
      kind: "player", me, linked: !!entry?.character, entry, player_casts: entry ? castsOn() : null,
      request: request ? { req: request.req, key: request.key, name: request.name, status: request.status, note: request.note } : null,
      aiming: aiming ? { key: aiming.key, name: aiming.name } : null,
      bridge: !!bridge && now() - bridge.at < BRIDGE_FRESH_MS,
    };
  }

  function publish(force = false) {
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (!force && key === lastSnap) return;
    lastSnap = key;
    send(CH.LOCAL_STATE, snap, "LOCAL");
  }

  function hello() {
    lastHello = now();
    return send(CH.HELLO, { role: ctx.role || "PLAYER", kind: ctx.kind || "", build: ctx.build || "", fx_ok: ctx.fx_ok ?? null, need: ["roster"] }, "REMOTE");
  }

  function onRoster(a, b) {
    // The bridge's ROSTER {to, entry, rev} for this player, as the message (or its broadcast
    // event), or as background.js passes it: onRoster(msg.entry, msg). entry null = the DM
    // unlinked this player.
    const m = b && typeof b === "object" && "entry" in b ? b : unwrap(a, "entry");
    if (!m || typeof m !== "object") return false;
    if (!("entry" in m)) return Array.isArray(m.items) ? onRoster({ entry: m }) : false; // a bare entry
    if (m.to && me && m.to !== me) return false; // someone else's list
    if (m.entry == null) {
      if (m.to == null) return false; // unaddressed: not ours to act on
      forget("unlinked by the DM");
      publish();
      return true;
    }
    if (typeof m.entry !== "object") return false;
    setEntry(cleanEntry(m.entry), { isFresh: true });
    writeCache();
    publish();
    return true;
  }

  function onBridge(msg) {
    const m = unwrap(msg, "conn");
    if (!m || typeof m !== "object") return;
    const changed = !bridge || bridge.conn !== (m.conn ?? null);
    if (changed && bridge) fresh = false; // a new bridge (the DM's tab reloaded): check the list with it
    bridge = { conn: m.conn ?? null, at: now(), player_casts: m.settings?.player_casts };
    if (!fresh) {
      // No list from this bridge yet (none at all, or only the cached copy).
      if (entry && asked && asked.conn === bridge.conn && now() - asked.at >= NO_ROSTER_MS) {
        // That bridge heard us ask and sent nothing back: we're not linked any more.
        forget("the bridge has no list for us");
      }
      if (changed || now() - lastHello >= HELLO_EVERY_MS) {
        if (hello()) asked = { conn: bridge.conn, at: now() };
      }
    }
    publish();
  }

  function dropTemplate(req) {
    try {
      aim?.clearTemplate?.(req, { fadeMs: 300 });
    } catch (e) {
      log("template not cleared", e);
    }
  }

  function onStatus(msg) {
    // What the DM decided about my request: waiting -> accepted / declined / told / error.
    const m = unwrap(msg, "req");
    if (!m || (m.to && me && m.to !== me)) return false;
    if (!request || m.req !== request.req) return false;
    const st = String(m.status || "");
    if (!STATUSES.includes(st) || !NEXT[request.status]?.has(st)) return false;
    request = { ...request, status: st, note: String(m.note || "") };
    if (st !== "waiting") dropTemplate(request.req); // accepted: the DM's own (public) template takes over
    publish();
    return true;
  }

  async function startFromPopover(x) {
    // A tap in the list: aim that item (area or target), or confirm it on yourself.
    const key = typeof x === "string" ? x : x?.key ?? x?.item?.key ?? x?.spec?.key;
    if (!key || !entry || !aim) return false;
    if (!castsOn()) {
      publish(true);
      return false;
    }
    const item = entry.items.find((i) => i.key === key);
    if (!item) return false;
    const spec = specFor(entry, item, { id: `p-${conn || me || "me"}-${++n}` });
    aiming = { id: spec.id, key, name: spec.label, spec };
    publish();
    try {
      OBR?.action?.close?.()?.catch?.(() => {}); // out of the way of the map
    } catch {
      // the popover closes itself too
    }
    let id = null;
    try {
      id = await aim.start(spec, {
        onLocked: (result, info) => onLocked(result, info),
        onCancelled: (aimId) => {
          if (aiming?.id === aimId) {
            aiming = null;
            publish();
          }
        },
      });
    } catch (e) {
      log("aim didn't start", e);
    }
    if (!id && aiming?.id === spec.id) {
      aiming = null;
      publish();
    }
    return !!id;
  }

  function onLocked(result, info = {}) {
    // The aim is locked: send the DM the request and keep my template drawn, amber and
    // dashed, until the DM answers.
    if (!result || result.cancel) return null;
    const aimId = result.aim_id;
    if (aimId != null && handled.has(aimId)) return null;
    const spec = aiming && (aimId == null || aiming.id === aimId) ? aiming.spec : info.spec;
    if (!spec?.key || !entry?.character) return null;
    if (aimId != null) handled.add(aimId);
    if (request?.status === "waiting") dropTemplate(request.req); // a newer request replaces it
    const req = `${conn || me || "p"}-${++n}`;
    const template = result.template || null, target = result.target ?? null;
    const ok = send(CH.CAST_REQUEST, { req, character: entry.character, key: spec.key, template, target }, "REMOTE");
    request = { req, key: spec.key, name: spec.label, status: ok ? "waiting" : "error", note: ok ? "" : "not sent", template, target, at: now() };
    aiming = null;
    if (template && ok) {
      try {
        aim?.showTemplate?.(req, template, "pending", {
          label: `${spec.label} · Waiting for the DM…`, color: spec.color, caught: (info.caught || []).filter((c) => !c.secret),
        });
      } catch (e) {
        log("pending template not shown", e);
      }
    }
    publish();
    return req;
  }

  function withdraw(req = null) {
    req = req || request?.req;
    if (!request || request.req !== req || request.status !== "waiting") return false;
    send(CH.CAST_WITHDRAW, { req }, "REMOTE");
    request = { ...request, status: "withdrawn", note: "" };
    dropTemplate(req);
    publish();
    return true;
  }

  function handleAsk(msg) {
    const m = unwrap(msg, "need");
    if (!m) return;
    if (m.need === "state") publish(true);
    else if (m.need === "aim") startFromPopover(m.key ?? m.item ?? m.spec);
    else if (m.need === "withdraw") withdraw(m.req);
  }

  function listen(ch, fn) {
    try {
      const off = deps.on ? deps.on(ch, fn) : OBR?.broadcast?.onMessage(ch, (ev) => fn(ev?.data));
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      log("can't listen on", ch, e);
    }
  }

  const ready = (async () => {
    try {
      if (!me && OBR?.player?.getId) me = await OBR.player.getId();
    } catch {
      // unknown until the first roster
    }
    try {
      if (!conn && OBR?.player?.getConnectionId) conn = await OBR.player.getConnectionId();
    } catch {
      // request ids fall back to the player id
    }
    // The list from last time shows at once, but only until the bridge says otherwise: we
    // still ask it (onBridge), and drop the copy if it has no list for us.
    if (!entry) setEntry(readCache(), { isFresh: false });
    listen(CH.LOCAL_ASK, handleAsk);
    hello();
    publish(true);
  })();

  function stop() {
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        // already off
      }
    }
  }

  return { ready, onRoster, onStatus, onBridge, snapshot, startFromPopover, onLocked, withdraw, handleAsk, hello, publish, stop };
}
