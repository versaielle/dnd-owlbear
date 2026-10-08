// "Your spells & attacks": what a player's popover shows, worked out from the background's
// snapshot (player/state.js). Pure, so check_player.mjs tests it offline and player.html
// only has to turn it into buttons.
//
// The snapshot carries the player's RosterEntry, which the DM's panel sends over the bridge:
// names and numbers only (no spell text), grouped Attacks, Cantrips, then Level N.
import { areaText } from "../aim/geometry.js?v=585985a-dc1dbb6";

export const TITLE = "Your spells & attacks";
export const HINT_UNLINKED = "Ask the DM to link you on the Party spells page";
export const HINT_VOICE = "The DM is taking casts by voice tonight";
export const HINT_EMPTY = "Nothing to cast yet: the DM sets your prepared spells";
export const HINT_LOADING = "Waiting for the DND panel…";

// What a tap does, by the item's aim mode: aim an area, pick a target, or confirm on yourself.
export const ACTION = { area: "aim", pick: "pick", self: "confirm" };
const ICON = { aim: "🎯", pick: "👆", confirm: "✋" };

const STATUS = {
  waiting: { text: "⏳ Waiting for the DM", tone: "wait" },
  accepted: { text: "✅ The DM took it: roll when asked", tone: "ok" },
  declined: { text: "The DM said not now", tone: "no" },
  told: { text: "✨ Told", tone: "ok" },
  error: { text: "⚠ That didn't reach the DM", tone: "no" },
  withdrawn: { text: "Withdrawn", tone: "dim" },
};

export function modeOf(item) {
  if (item?.mode === "area" || item?.mode === "self" || item?.mode === "pick") return item.mode;
  return item?.area ? "area" : "pick";
}

export function groupRank(name) {
  if (name === "Attacks") return 0;
  if (name === "Cantrips") return 1;
  const m = /^Level\s+(\d+)$/.exec(String(name || ""));
  return m ? 1 + +m[1] : 99;
}

const numOrNull = (v) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() && isFinite(+v) ? +v : null);

export function selfOk(item) {
  // May the player pick their own token for this? Never for an attack. Otherwise only when the
  // roster says so (self_ok, or a spell aimed at an ally), or for a spell cast by touch (Cure
  // Wounds, Guidance: you can touch yourself). Fire Bolt or Hold Person never offer "you".
  if (!item || item.kind === "attack") return false;
  if (typeof item.self_ok === "boolean") return item.self_ok;
  if (item.target != null) return item.target === "ally";
  const r = numOrNull(item.range_ft);
  return (r != null && r > 0 && r <= 5) || /(^| · )touch( · |$)/i.test(String(item.label || ""));
}

export function specFor(entry, item, { id = null } = {}) {
  // The AimSpec for one of the player's items (spec section 7.1), aimed from their token.
  // A new request from the same player replaces the old one, so the id only has to be fresh.
  const mode = modeOf(item);
  const area = mode === "area" ? item.area || null : null;
  return {
    id: id || `p-${item.key}`, who: "player", character: entry?.character ?? null, key: item.key,
    label: item.name || item.key, area_text: area ? areaText(area) : "", save_label: item.save_label || "",
    mode, area, range_ft: numOrNull(item.range_ft), long_ft: numOrNull(item.long_ft), count: 1,
    color: item.color || null, caster_token: entry?.token || null, self_ok: selfOk(item),
  };
}

export function statusView(req) {
  // The request card: "⏳ Waiting for the DM" with ✕ Withdraw, then what the DM decided.
  if (!req || !STATUS[req.status]) return null;
  const s = STATUS[req.status];
  return { req: req.req, name: req.name || req.key || "", status: req.status, text: s.text, tone: s.tone,
           note: req.note || "", canWithdraw: req.status === "waiting" };
}

function itemView(item) {
  const mode = modeOf(item), action = ACTION[mode];
  const name = item.name || item.key;
  // The sub-line: the label's details after the name ("20-ft square"), the save and the range.
  const rest = String(item.label || "").split(" · ").filter((p) => p && p !== name);
  if (!rest.length && item.area) rest.push(areaText(item.area));
  if (!rest.length && item.range_ft) rest.push(item.long_ft ? `${item.range_ft}/${item.long_ft} ft` : `${item.range_ft} ft`);
  if (item.save_label) rest.push(item.save_label);
  if (mode === "self") rest.push("on yourself");
  return { key: item.key, name, sub: rest.join(" · "), action, icon: ICON[action], conc: !!item.conc, kind: item.kind || "spell" };
}

export function view(snap) {
  const out = { title: TITLE, who: null, hint: null, note: null, groups: [], status: null, aiming: null };
  if (!snap) {
    out.hint = HINT_LOADING;
    return out;
  }
  out.status = statusView(snap.request);
  out.aiming = snap.aiming?.key || null;
  const e = snap.entry;
  if (!e || !e.character) {
    out.hint = HINT_UNLINKED;
    return out;
  }
  out.who = e.character;
  if (snap.player_casts === false || e.player_casts === false) {
    out.hint = HINT_VOICE;
    return out;
  }
  const items = Array.isArray(e.items) ? e.items.filter((i) => i && i.key) : [];
  if (!items.length) {
    out.hint = HINT_EMPTY;
    return out;
  }
  if (!e.token) out.note = "Your token isn't on this map: you'll tap where you stand first.";
  const groups = new Map();
  for (const item of items) {
    const name = item.group || (item.kind === "attack" ? "Attacks" : "Spells");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(itemView(item));
  }
  out.groups = [...groups.entries()]
    .sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
    .map(([name, list]) => ({ name, items: list }));
  return out;
}
