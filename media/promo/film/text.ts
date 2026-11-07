/**
 * 把一行字变成体素的格子。字体是 Fusion Pixel 12px，一个字体像素对应一个体素，
 * 和 24×24 的 Pupu 是同一种颗粒。放大八倍画到画布上再取每格中心，不受抗锯齿影响。
 */
const ZOOM = 8;
export const LINE = 14;

let ready: Promise<void> | null = null;

export function loadFont() {
  ready ??= (async () => {
    const face = new FontFace("Fusion", "url(/media/promo/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2)");
    await face.load();
    document.fonts.add(face);
  })();
  return ready;
}

export type Cell = { x: number; y: number; glyph: number };
export type Line = { width: number; cells: Cell[]; glyphs: number };

const cache = new Map<string, Line>();

/** x 向右，y 向上，原点在这行左下角，行高 LINE。 */
export function line(text: string): Line {
  const hit = cache.get(text);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const font = `${12 * ZOOM}px Fusion`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width / ZOOM);
  canvas.width = width * ZOOM;
  canvas.height = LINE * ZOOM;
  context.font = font;
  context.fontKerning = "none";
  context.fillStyle = "#fff";
  context.textBaseline = "alphabetic";
  context.fillText(text, 0, 11 * ZOOM);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

  const edges: number[] = [];
  for (let index = 1; index <= text.length; index++) edges.push(context.measureText(text.slice(0, index)).width / ZOOM);

  const cells: Cell[] = [];
  for (let row = 0; row < LINE; row++) {
    for (let column = 0; column < width; column++) {
      const at = ((row * ZOOM + ZOOM / 2) * canvas.width + column * ZOOM + ZOOM / 2) * 4;
      if (data[at + 3]! < 128) continue;
      let glyph = edges.findIndex((edge) => column + 0.5 < edge);
      if (glyph < 0) glyph = text.length - 1;
      cells.push({ x: column, y: LINE - 1 - row, glyph });
    }
  }
  const made = { width, cells, glyphs: text.length };
  cache.set(text, made);
  return made;
}
