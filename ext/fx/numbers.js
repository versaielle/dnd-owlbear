// Floating numbers over a token ("−12", "+5", "miss", "½ 12"): a local Text item on the TEXT
// layer that drifts up 0.6 of a cell over its 900 ms and fades out over the last 30%.
// The item is built with Owlbear's buildText, then its style is set directly on the built item,
// so it works whatever the SDK's text-builder method names are.
import { finite } from "./place.js?v=4e816a5";

// Fill colour per tone; every number gets a dark outline so it reads on any map.
export const TONES = {
  damage: "#ff5a4d",
  heal: "#5cff9d",
  miss: "#d7dde5",
  half: "#ffd34d",
};

const easeout = (x) => 1 - (1 - x) * (1 - x);
const fadeOf = (p) => 1 - Math.min(1, Math.max(0, (p - 0.7) / 0.3));

// The Text item for a number part above footprint `fp`, `stack` places it higher when another
// number is already floating over the same token. Returns {item, frame(draft, p)} or null.
export function numberItem(api, part, fp, G, { stack = 0, until = 0, key = "dnd-npc/fx", z = 0 } = {}) {
  const text = String(part.text ?? "").slice(0, 16);
  if (!text || !fp || !finite(fp.x, fp.y)) return null;
  const dpi = G.dpi;
  const W = dpi * 2.4, H = dpi * 0.6;
  const tokenH = Math.max(fp.h || 0, dpi * 0.8);
  const x0 = fp.x - W / 2;
  const y0 = fp.y - tokenH / 2 - H * 0.75 - stack * H * 0.7;
  const fill = TONES[part.tone] || TONES.damage;
  const item = api.buildText()
    .plainText(text)
    .textType("PLAIN")
    .position({ x: x0, y: y0 })
    .layer("POINTER")
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .zIndex(z)
    .name("dnd-npc fx number")
    .metadata({ [key]: { until } })
    .build();
  item.text = {
    ...(item.text || {}),
    plainText: text,
    type: "PLAIN",
    width: W,
    height: H,
    style: {
      ...(item.text?.style || {}),
      fontSize: Math.round(dpi / 3),
      fontWeight: 800,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: "#151515",
      strokeOpacity: 0.95,
      strokeWidth: Math.max(2, Math.round(dpi / 30)),
      textAlign: "CENTER",
      textAlignVertical: "MIDDLE",
      padding: 0,
      lineHeight: 1.1,
    },
  };
  const rise = dpi * 0.6;
  return {
    item,
    frame(draft, p) {
      draft.position = { x: x0, y: y0 - rise * easeout(Math.min(1, Math.max(0, p))) };
      const o = fadeOf(p);
      if (draft.text?.style) {
        draft.text.style.fillOpacity = o;
        draft.text.style.strokeOpacity = 0.95 * o;
      }
    },
  };
}
