// A map's explored squares (docs/vision-layer-spec.md section 6, "Seen squares"): one bit per
// square, row by row (index = row * cols + col, as fog/los.js seenCells gives them), and the value
// kept in the map image's metadata (dnd-npc/seen). Pure: no Owlbear import, so the offline checks
// load it too.
//
//   createBits(cols, rows)    all unseen; null for a broken size
//   getBit(b, i) / setBit(b, i)   setBit says whether it changed anything
//   setBits(b, indices)       how many of them were new (the writer writes only on a change)
//   union(a, b)               a new set with both; null when the sizes differ
//   count(b)                  how many are set
//   encode(b)                 {v: 1, cols, rows, bits}: bits is base64
//   decode(value, cols, rows) the set back, or null when it isn't one of this size (rejected)
//   load(value, cols, rows)   decode's, else an empty set of this size (reset: the map changed)
//
// bits: a format byte, then the data.
//   0  raw: one bit per square, low bit first in each byte.
//   1  runs: each row XORed with the row above (a shape's straight sides then cost nothing), read
//      as alternate runs of 0s and 1s (0s first, maybe none), each run's length + 1 as an Elias
//      gamma code, high bit first; the last byte padded with 0s.
// encode keeps the shorter. A 100 x 100 map the party walked by day, past walled buildings, comes
// to about 650 characters (raw is 1668); noise, which nothing shrinks, is raw plus one byte.

export const VERSION = 1;
const MAX_CELLS = 1 << 20; // a 1024 x 1024 map: anything bigger is junk
const RAW = 0, RUNS = 1;

const sizeOk = (cols, rows) => Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols * rows <= MAX_CELLS;

export function createBits(cols, rows) {
  if (!sizeOk(cols, rows)) return null;
  return { cols, rows, bytes: new Uint8Array(Math.ceil((cols * rows) / 8)) };
}

const inRange = (b, i) => Number.isInteger(i) && i >= 0 && i < b.cols * b.rows;

export const getBit = (b, i) => !!b && inRange(b, i) && (b.bytes[i >> 3] & (1 << (i & 7))) !== 0;

export function setBit(b, i) {
  if (!b || !inRange(b, i) || getBit(b, i)) return false;
  b.bytes[i >> 3] |= 1 << (i & 7);
  return true;
}

export function setBits(b, indices) {
  let n = 0;
  for (const i of indices || []) if (setBit(b, i)) n++;
  return n;
}

export function union(a, b) {
  if (!a || !b || a.cols !== b.cols || a.rows !== b.rows) return null;
  const out = createBits(a.cols, a.rows);
  for (let k = 0; k < out.bytes.length; k++) out.bytes[k] = a.bytes[k] | b.bytes[k];
  return out;
}

export function count(b) {
  let n = 0;
  for (const x of b?.bytes || []) { let v = x; while (v) { v &= v - 1; n++; } }
  return n;
}

// ---- the metadata value ----

function toBase64(bytes) {
  let s = "";
  for (let k = 0; k < bytes.length; k += 0x2000) s += String.fromCharCode(...bytes.subarray(k, k + 0x2000));
  return btoa(s);
}

function fromBase64(text) {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
    return out;
  } catch { return null; }
}

const bitOf = (bytes, i) => (bytes[i >> 3] >> (i & 7)) & 1;

// The runs format's bytes (format byte first).
function runs(b) {
  const n = b.cols * b.rows, out = [RUNS];
  let acc = 0, used = 0;
  const put = (bit) => { acc = (acc << 1) | bit; if (++used === 8) { out.push(acc); acc = 0; used = 0; } };
  const gamma = (v) => { // v >= 1: as many 0s as v has bits after its top one, then v's bits
    const top = 31 - Math.clz32(v);
    for (let k = 0; k < top; k++) put(0);
    for (let k = top; k >= 0; k--) put((v >>> k) & 1);
  };
  let want = 0, len = 0;
  for (let i = 0; i < n; i++) {
    const x = bitOf(b.bytes, i) ^ (i >= b.cols ? bitOf(b.bytes, i - b.cols) : 0);
    if (x === want) { len++; continue; }
    gamma(len + 1);
    want ^= 1;
    len = 1;
  }
  gamma(len + 1);
  if (used) out.push(acc << (8 - used));
  return out;
}

// The runs format back into b (format byte first in data): false when it isn't exactly b's size.
function unruns(data, b) {
  const n = b.cols * b.rows, end = data.length * 8;
  let pos = 8;
  const get = () => { if (pos >= end) return -1; const bit = (data[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return bit; };
  const x = new Uint8Array(n); // the rows, still XORed with the row above
  let i = 0, one = 0;
  while (i < n) {
    let top = 0, bit;
    while ((bit = get()) === 0) if (++top > 20) return false; // no run is longer than MAX_CELLS
    if (bit < 0) return false;
    let v = 1;
    for (let k = 0; k < top; k++) { if ((bit = get()) < 0) return false; v = v * 2 + bit; }
    if (i + v - 1 > n) return false;
    if (one) x.fill(1, i, i + v - 1);
    i += v - 1;
    one ^= 1;
  }
  if (Math.ceil(pos / 8) !== data.length) return false; // more than the last byte's padding left over
  for (let k = 0; k < n; k++) if (x[k] ^ (k >= b.cols ? bitOf(b.bytes, k - b.cols) : 0)) b.bytes[k >> 3] |= 1 << (k & 7);
  return true;
}

export function encode(b) {
  if (!b || !sizeOk(b.cols, b.rows)) return null;
  const raw = new Uint8Array(b.bytes.length + 1);
  raw.set(b.bytes, 1); // raw[0] = RAW
  const r = runs(b);
  return { v: VERSION, cols: b.cols, rows: b.rows, bits: toBase64(r.length < raw.length ? Uint8Array.from(r) : raw) };
}

export function decode(value, cols, rows) {
  if (!value || value.v !== VERSION || typeof value.bits !== "string") return null;
  if (!sizeOk(value.cols, value.rows) || value.cols !== cols || value.rows !== rows) return null;
  const data = fromBase64(value.bits);
  if (!data || !data.length) return null;
  const b = createBits(cols, rows), n = cols * rows;
  if (data[0] === RAW) {
    if (data.length !== b.bytes.length + 1) return null;
    b.bytes.set(data.subarray(1));
    if (n % 8) b.bytes[b.bytes.length - 1] &= (1 << (n % 8)) - 1; // nothing past the last square
    return b;
  }
  return data[0] === RUNS && unruns(data, b) ? b : null;
}

export const load = (value, cols, rows) => decode(value, cols, rows) ?? createBits(cols, rows);
