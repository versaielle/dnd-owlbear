// Is this token a player character? ONE answer for the whole extension (the 🔥 Light menu,
// 🧭 Bring PCs, the spell lights job, every screen's R1 test) and the panel (map_state.py
// pc_name, the same rule in Python). Both run the same list of cases, tests/pc_rule_cases.json
// (node owlbear/check_pcs.mjs, tests/test_pc_rule.py): change the rule in both, with a case.
//
// The rule, in order:
//   1. Only a token on the CHARACTER layer can be a PC (a torch prop, a mount, a map never is).
//   2. Its WHO mark (🗺 This is…, WHO_KEY) wins whenever it has one. "pc:<name>" is a PC, named
//      as the party spells it when the name matches a member (any case), else the member its
//      label matches, else the mark's own name (a PC the party list doesn't have yet is still a
//      PC). Any other mark ("npc:<slug>") is never a PC, whatever the token is called.
//   3. No mark: the ids the panel already knows are PCs (pcIds: the bridge heartbeat's
//      pc_tokens, a spell job's pc flags), when the caller has them, say yes.
//   4. Else the name the token shows (Stat Bubbles' name tag, else Owlbear's label, else the
//      item's name) against the party, without case, a picture's file extension, punctuation,
//      underscores or a leading "the": the whole name first ("Ana"), else its first word
//      ("Ana Ring", "ana_ring"), each against every member in roster order.
// The party's names are first names (personas/party.yaml), so "the first word" is what lets the
// ring tokens under the minis ("Ana Ring", ana_ring.png) count, while "Anaconda" or "Ana's
// hound" don't. A label that only shares a first word with a member ("Ana the Bold") is that
// member; a hidden monster named after a PC would count as a PC (public), so don't.
// (No party member's name in this file: it's published, R9.)
// No aliases: party.yaml has none, and the room only keeps the names (PARTY_KEY).
import { BUBBLES_NAME_KEY, WHO_KEY } from "../keys.js?v=585985a-dc1dbb6";

const EXT = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const WORD = /[\p{L}\p{N}'’-]+/gu; // letters, digits, apostrophes and hyphens; anything else splits

// A name as the rule compares it: "The Ana_Ring.png" -> "ana ring". "" for no name.
export function nameKey(s) {
  const words = String(s ?? "").trim().replace(EXT, "").toLowerCase().match(WORD) || [];
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

const firstOf = (key) => key.split(" ")[0];

// The name a token shows: Stat Bubbles' name tag, then Owlbear's label, then the item's name.
export function tokenLabel(i) {
  return String(i?.metadata?.[BUBBLES_NAME_KEY] || "").trim() || String(i?.text?.plainText || "").trim()
    || String(i?.name || "");
}

// The party member a name is (rule 4), or null: the whole name, else the first word.
export function memberNamed(name, party = []) {
  const key = nameKey(name);
  if (!key) return null;
  const names = (Array.isArray(party) ? party : []).filter((n) => typeof n === "string" && nameKey(n));
  return names.find((n) => nameKey(n) === key) || names.find((n) => firstOf(nameKey(n)) === firstOf(key)) || null;
}

// The WHO mark on an item: null (none), {pc: true, name} or {pc: false} (any other mark).
export function markOf(i) {
  const mark = String(i?.metadata?.[WHO_KEY] || "").trim(); // as the map report sends it (background.js)
  if (!mark) return null;
  const name = mark.startsWith("pc:") ? mark.slice(3).trim() : "";
  return name ? { pc: true, name } : { pc: false };
}

const onCharacterLayer = (i) => (i?.layer || "CHARACTER") === "CHARACTER";

// The PC a token is (rules 1, 2 and 4), or null.
export function pcName(i, party = []) {
  if (!i || !onCharacterLayer(i)) return null;
  const mark = markOf(i);
  if (mark) return mark.pc ? memberNamed(mark.name, party) || memberNamed(tokenLabel(i), party) || mark.name : null;
  return memberNamed(tokenLabel(i), party);
}

// pcIds as a Set, an array or a function (id) -> bool; anything else knows none.
function knows(pcIds, id) {
  try {
    if (typeof pcIds === "function") return !!pcIds(id);
    if (pcIds instanceof Set) return pcIds.has(id);
    return Array.isArray(pcIds) && pcIds.includes(id);
  } catch {
    return false;
  }
}

// Is this item a player character (rules 1-4)?
export function isPcToken(i, { party = [], pcIds = null } = {}) {
  if (!i || !onCharacterLayer(i)) return false;
  const mark = markOf(i);
  if (mark) return mark.pc;
  return knows(pcIds, i.id) || !!memberNamed(tokenLabel(i), party);
}

// The marks to write so every screen (and every later reader) knows these PCs by their token:
// [{id, who: "pc:<name>"}] for each token isPcToken() calls a PC (the panel's pcIds, or its
// name against the party) that has no WHO mark yet, named as the party spells it. Never a token
// that already has a mark (an "npc:" one, or the DM's own This is… choice). A token only pcIds
// knows, whose name matches no member of `party` (the room's list is older than the panel's),
// is left out until it does: there's no name to write.
export function whoMarksFor(items, pcIds, party = []) {
  const out = [];
  for (const i of Array.isArray(items) ? items : []) {
    if (!i?.id || markOf(i) || !isPcToken(i, { party, pcIds })) continue;
    const name = memberNamed(tokenLabel(i), party);
    if (name) out.push({ id: i.id, who: `pc:${name}` });
  }
  return out;
}

// Write whoMarksFor()'s marks on the drafts of an Owlbear updateItems(): only where the draft
// still has no mark (one the DM set meanwhile is kept). Returns how many it wrote.
export function applyWhoMarks(drafts, marks) {
  const want = new Map((marks || []).map((m) => [m.id, m.who]));
  let n = 0;
  for (const d of drafts || []) {
    if (!want.has(d.id) || markOf(d)) continue;
    d.metadata = d.metadata || {};
    d.metadata[WHO_KEY] = want.get(d.id);
    n++;
  }
  return n;
}
