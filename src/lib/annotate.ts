/**
 * Turns a captureVisibleTab PNG into the pasted image: the crop, a red outline around a selected
 * element, and a caption with the comment, page URL and element below it.
 */
import { cropFor, intersectRects, roundRect, scaleRect, wrapText, type Rect, type Size } from "./geometry.ts";

export interface Annotation {
  kind: "element" | "area";
  /** Selected element box or drawn area, CSS px relative to the viewport at capture time. */
  rect: Rect;
  viewport: Size;
  comment: string;
  url: string;
  /** Short element hint such as `button.primary "Save"`; element selections only. */
  element?: string;
}

const RED = "#e11d2e";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** Caption layout in CSS px; scaled by the screenshot's image px per CSS px. */
const PAD = 12;
const MIN_WIDTH = 360;
const COMMENT_SIZE = 15;
const META_SIZE = 12;
const LINE_HEIGHT = 1.4;

/** Plain-text twin of the caption, written to the clipboard next to the image. */
export function annotationText(a: Annotation): string {
  const meta = [`Page: ${a.url}`, ...(a.element ? [`Element: ${a.element}`] : [])].join("\n");
  return a.comment ? `${a.comment}\n\n${meta}` : meta;
}

export async function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  // Decoded by hand: fetch(data:…) can be blocked by the page's Content Security Policy.
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

export async function renderAnnotation(screenshotDataUrl: string, a: Annotation): Promise<Blob> {
  const shot = await decodeDataUrl(screenshotDataUrl);
  // Image px per CSS px, from the real image size: devicePixelRatio misses zoom and fractional scaling.
  const s = shot.width / a.viewport.width;
  const cropCss = cropFor(a.kind, a.rect, a.viewport);
  if (!cropCss) throw new Error("The selection is not visible in the viewport.");
  const crop = roundRect(scaleRect(cropCss, s));

  const width = Math.max(crop.width, Math.round(MIN_WIDTH * s));
  const pad = Math.round(PAD * s);
  const commentFont = `${Math.round(COMMENT_SIZE * s)}px ${FONT}`;
  const metaFont = `${Math.round(META_SIZE * s)}px ${FONT}`;
  const commentLine = Math.round(COMMENT_SIZE * s * LINE_HEIGHT);
  const metaLine = Math.round(META_SIZE * s * LINE_HEIGHT);

  const measureCanvas = new OffscreenCanvas(1, 1).getContext("2d")!;
  const wrap = (text: string, font: string) => {
    measureCanvas.font = font;
    return wrapText(text, width - 2 * pad, (t) => measureCanvas.measureText(t).width);
  };
  const commentLines = a.comment ? wrap(a.comment, commentFont) : [];
  const metaLines = [...wrap(a.url, metaFont), ...(a.element ? wrap(a.element, metaFont) : [])];
  const gap = commentLines.length ? Math.round(6 * s) : 0;
  const captionHeight = 2 * pad + commentLines.length * commentLine + gap + metaLines.length * metaLine;

  const canvas = new OffscreenCanvas(width, crop.height + captionHeight);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(0, 0, width, crop.height);
  ctx.drawImage(shot, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  shot.close();

  if (a.kind === "element") {
    const box = intersectRects(roundRect(scaleRect(a.rect, s)), crop);
    if (box) {
      const line = Math.max(2, Math.round(2 * s));
      ctx.strokeStyle = RED;
      ctx.lineWidth = line;
      ctx.strokeRect(box.x - crop.x + line / 2, box.y - crop.y + line / 2, box.width - line, box.height - line);
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, crop.height, width, captionHeight);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(0, crop.height, width, Math.max(1, Math.round(s)));
  ctx.textBaseline = "top";
  let y = crop.height + pad;
  ctx.font = commentFont;
  ctx.fillStyle = "#111827";
  for (const l of commentLines) {
    ctx.fillText(l, pad, y);
    y += commentLine;
  }
  y += gap;
  ctx.font = metaFont;
  ctx.fillStyle = "#6b7280";
  for (const l of metaLines) {
    ctx.fillText(l, pad, y);
    y += metaLine;
  }
  return canvas.convertToBlob({ type: "image/png" });
}
