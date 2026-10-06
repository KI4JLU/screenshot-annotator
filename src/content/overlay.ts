/**
 * Selection overlay, injected on demand with chrome.scripting.executeScript({ files: ["content.js"] }).
 *
 * - Shadow DOM host fixed over the viewport at max z-index (top layer via popover when available),
 *   so the page layout is untouched and page events are swallowed.
 * - Click selects the element under the pointer; dragging selects a free area. Esc cancels.
 * - Then a comment box opens. Enter copies, Shift+Enter adds a line, Ctrl/Cmd+Enter starts a
 *   T3 Code thread in the chosen project (when the extension is paired with T3 Code).
 * - On start the page is paused: running animations and playing media stop, and the viewport is
 *   captured and shown as a still under the overlay. Selection happens on that still, and the
 *   annotation is cut from it, so hover menus and moving content stay as they were. Teardown
 *   resumes the page. The image is rendered here and written to the clipboard.
 */
import { annotationText, decodeDataUrl, renderAnnotation, type Annotation } from "../lib/annotate.ts";
import { rectFromPoints, type Point, type Rect } from "../lib/geometry.ts";
import type { CaptureResponse, ContentToWorker, T3ProjectsResponse, T3SendResponse, WorkerToContent } from "../lib/messages.ts";
import { threadTitle } from "../lib/t3.ts";

declare global {
  interface Window {
    __screenshotAnnotator?: { start(): Promise<void> };
  }
}

const Z = "2147483647";
/** Pointer travel (CSS px) that turns a click into an area drag, and the smallest usable area. */
const DRAG_THRESHOLD = 4;
const MIN_AREA = 8;
const TOAST_MS = 4000;

/** Rects are taken when selecting: the still does not move, even if the page does. */
type Selection = { kind: "element"; rect: Rect; description: string } | { kind: "area"; rect: Rect };

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

function isFormField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Short hint like `button.primary "Save"` that helps an agent find the element in the code. */
function describeElement(el: Element): string {
  let desc = el.tagName.toLowerCase();
  if (el.id && el.id.length <= 40) desc += `#${CSS.escape(el.id)}`;
  for (const c of [...el.classList].filter((c) => c.length <= 40).slice(0, 2)) desc += `.${CSS.escape(c)}`;
  const attrLabel = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
  // Form fields are described by their labels, never by their value (it may be a password).
  const label = collapse(
    isFormField(el)
      ? attrLabel || el.labels?.[0]?.innerText || el.getAttribute("placeholder")
      : attrLabel || (el instanceof HTMLElement ? el.innerText : el.textContent),
  );
  if (label) desc += ` "${capText(label, 60)}"`;
  return desc;
}

function rectOf(node: Element): Rect {
  const r = node.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Pauses running animations (CSS and Web Animations) and playing media; returns the resume. */
function pausePage(): () => void {
  const animations = document.getAnimations().filter((a) => a.playState === "running");
  const media = [...document.querySelectorAll<HTMLMediaElement>("audio, video")].filter((m) => !m.paused);
  for (const a of animations) a.pause();
  for (const m of media) m.pause();
  return () => {
    // Skip what the page cancelled or restarted meanwhile.
    for (const a of animations) if (a.playState === "paused") a.play();
    for (const m of media) if (m.paused) void m.play().catch(() => undefined);
  };
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

function toWorker<R>(msg: ContentToWorker): Promise<R> {
  return chrome.runtime.sendMessage(msg) as Promise<R>;
}

async function captureViewport(): Promise<string> {
  const res = await toWorker<CaptureResponse>({ type: "capture" });
  if (!res.ok) throw new Error(`Screenshot failed: ${res.error}`);
  return res.dataUrl;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}

async function copyToClipboard(png: Promise<Blob>, text: string): Promise<void> {
  // Pages served over plain http (other than localhost) have no async clipboard.
  if (!navigator.clipboard?.write) throw new Error("This page is not a secure context, so it has no clipboard access.");
  // Passing the promise lets the write start inside the Enter/click gesture while the image renders.
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": png, "text/plain": new Blob([text], { type: "text/plain" }) }),
  ]);
}

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; cursor: crosshair; font: 13px/1.4 system-ui, sans-serif; }
.still { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; display: block; pointer-events: none; }
.layer.commenting { cursor: default; }
.box {
  position: fixed; pointer-events: none; display: none; box-sizing: border-box;
  border: 2px solid #e11d2e; background: rgba(225,29,46,0.08); border-radius: 2px;
}
.tag {
  position: fixed; pointer-events: none; display: none; max-width: 60vw; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; padding: 2px 6px; border-radius: 3px;
  font-size: 12px; color: #fff; background: #e11d2e;
}
.hint {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%); pointer-events: none;
  padding: 6px 12px; border-radius: 6px; color: #fff; background: rgba(17,24,39,0.92);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.hint.bottom { top: auto; bottom: 12px; }
.panel {
  position: fixed; display: none; width: 320px; box-sizing: border-box; padding: 8px;
  border-radius: 8px; background: #fff; color: #111827; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
textarea {
  display: block; width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical;
  padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px;
  font: 14px/1.4 system-ui, sans-serif; color: #111827; background: #fff;
}
textarea:focus { outline: 2px solid #e11d2e; outline-offset: -1px; }
.actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.t3 { display: flex; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e7eb; }
.t3 select {
  flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 4px;
  font: 13px/1.4 system-ui, sans-serif; color: #111827; background: #fff;
}
.t3 select[hidden] { display: none; }
.t3-status { margin-top: 4px; font-size: 12px; color: #6b7280; }
.t3-status:empty { display: none; }
button {
  padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer;
  font: 13px/1.4 system-ui, sans-serif; color: #111827; background: #fff;
}
button.primary { border-color: #e11d2e; color: #fff; background: #e11d2e; }
button:disabled { opacity: 0.5; cursor: default; }
.toast {
  display: flex; flex-direction: column; gap: 6px; max-width: 360px; padding: 10px 12px;
  border-radius: 8px; font: 13px/1.4 system-ui, sans-serif; color: #fff;
  background: rgba(17,24,39,0.95); box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.toast img { max-width: 100%; max-height: 160px; object-fit: contain; align-self: flex-start; background: #fff; }
.toast button { align-self: flex-end; }
`;

/** Host element in the top layer with a closed shadow root holding STYLE. */
function mountHost(extraCss: string[]): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.setAttribute("data-screenshot-annotator", "");
  host.style.cssText = [
    "all: initial",
    "position: fixed",
    "margin: 0",
    "padding: 0",
    "border: 0",
    "background: transparent",
    "overflow: visible",
    "display: block",
    `z-index: ${Z}`,
    ...extraCss,
  ]
    .map((d) => `${d} !important`)
    .join(";");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);
  document.documentElement.append(host);
  // Top layer keeps the overlay above open modal dialogs of the page.
  try {
    host.setAttribute("popover", "manual");
    host.showPopover();
  } catch {
    host.removeAttribute("popover");
  }
  return { host, root };
}

function unmountHost(host: HTMLElement): void {
  try {
    if (host.matches(":popover-open")) host.hidePopover();
  } catch {
    /* popover unsupported */
  }
  host.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function createOverlay(): { start(): Promise<void> } {
  let phase: "select" | "comment" | null = null;
  let starting = false;
  /** Screenshot taken when the page was paused, and the viewport it shows. */
  let still: { dataUrl: string; viewport: { width: number; height: number } } | null = null;
  let resumePage: (() => void) | null = null;
  let host: HTMLElement | null = null;
  let parts: {
    layer: HTMLElement;
    box: HTMLElement;
    tag: HTMLElement;
    hint: HTMLElement;
    panel: HTMLElement;
    textarea: HTMLTextAreaElement;
    root: ShadowRoot;
    project: HTMLSelectElement;
    send: HTMLButtonElement;
    t3Status: HTMLElement;
  } | null = null;
  let t3: T3ProjectsResponse | null = null;
  let toastHost: HTMLElement | null = null;
  let toastTimer: number | undefined;
  let toastImageUrl: string | undefined;
  let pointer: Point | null = null;
  let dragStart: Point | null = null;
  let dragging = false;
  let selection: Selection | null = null;

  const underPointer = (p: Point): Element | null =>
    document.elementsFromPoint(p.x, p.y).find((e) => e !== host && !host?.contains(e)) ?? null;

  const showBox = (r: Rect) => {
    if (!parts) return;
    Object.assign(parts.box.style, {
      display: "block",
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  };

  const updateHover = () => {
    if (!parts || !pointer || phase !== "select") return;
    parts.hint.classList.toggle("bottom", pointer.y < 80);
    if (dragging && dragStart) {
      showBox(rectFromPoints(dragStart, pointer));
      parts.tag.style.display = "none";
      return;
    }
    const target = underPointer(pointer);
    if (!target) {
      parts.box.style.display = "none";
      parts.tag.style.display = "none";
      return;
    }
    const r = target.getBoundingClientRect();
    showBox({ x: r.left, y: r.top, width: r.width, height: r.height });
    parts.tag.textContent = describeElement(target);
    const tagTop = r.top >= 24 ? r.top - 22 : Math.min(r.bottom + 4, window.innerHeight - 22);
    Object.assign(parts.tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${tagTop}px` });
  };

  /**
   * The shadow root is closed, so window listeners see our events retargeted to the host. Focus
   * only ever sits in the comment box; pointer events count when they land on it.
   */
  const inPanel = (e: Event) => {
    if (phase !== "comment" || !parts || e.target !== host) return false;
    if (e instanceof KeyboardEvent) return true;
    if (!(e instanceof MouseEvent)) return false;
    const r = parts.panel.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  /** Swallows page events, except those aimed at the comment box. */
  const block = (e: Event) => {
    if (!phase || inPanel(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onPointerDown = (e: PointerEvent) => {
    block(e);
    if (phase !== "select" || e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY };
    dragging = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    block(e);
    pointer = { x: e.clientX, y: e.clientY };
    if (dragStart && !dragging) {
      dragging = Math.hypot(pointer.x - dragStart.x, pointer.y - dragStart.y) > DRAG_THRESHOLD;
    }
    updateHover();
  };

  const onPointerUp = (e: PointerEvent) => {
    block(e);
    if (phase !== "select" || !dragStart) return;
    const end = { x: e.clientX, y: e.clientY };
    const start = dragStart;
    const wasDrag = dragging;
    dragStart = null;
    dragging = false;
    if (wasDrag) {
      const rect = rectFromPoints(start, end);
      if (rect.width >= MIN_AREA && rect.height >= MIN_AREA) openComment({ kind: "area", rect });
      else updateHover();
      return;
    }
    const target = underPointer(end);
    if (target) openComment({ kind: "element", rect: rectOf(target), description: describeElement(target) });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!phase) return;
    if (e.key === "Escape") {
      block(e);
      teardown();
      return;
    }
    if (inPanel(e)) {
      if (e.type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (t3?.state === "ok") sendToT3();
        } else if (parts?.root.activeElement === parts?.textarea) {
          e.preventDefault();
          copy();
        }
      }
      // Keep typing away from page shortcuts; the default action (text input) still happens.
      e.stopImmediatePropagation();
      return;
    }
    block(e);
  };

  // The still does not scroll, and the page cannot be resized under it.
  const onResize = () => teardown();

  const placePanel = () => {
    if (!parts || !selection) return;
    const r = selection.rect;
    const w = 320;
    const h = parts.panel.offsetHeight || 130;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.y + r.height + gap;
    if (top + h > vh) top = r.y - h - gap >= 0 ? r.y - h - gap : Math.max(gap, vh - h - gap);
    const left = Math.min(Math.max(gap, r.x), Math.max(gap, vw - w - gap));
    Object.assign(parts.panel.style, { display: "block", left: `${left}px`, top: `${top}px` });
  };

  const openComment = (sel: Selection) => {
    if (!parts) return;
    selection = sel;
    phase = "comment";
    parts.layer.classList.add("commenting");
    parts.tag.style.display = "none";
    parts.hint.classList.remove("bottom");
    parts.hint.textContent = "Add a comment · Enter copies · Shift+Enter new line · Esc cancels";
    showBox(sel.rect);
    placePanel();
    parts.textarea.focus();
    void loadT3();
  };

  /** Fills the project picker, or turns the button into a link to the options page. */
  const loadT3 = async () => {
    if (!parts) return;
    const { project, send, t3Status } = parts;
    t3 = null;
    project.hidden = true;
    send.disabled = true;
    send.textContent = "Send to T3 Code";
    t3Status.textContent = "";
    const res = await toWorker<T3ProjectsResponse>({ type: "t3/projects", host: location.host }).catch(
      (e: unknown): T3ProjectsResponse => ({ state: "error", error: String(e) }),
    );
    if (!parts || parts.project !== project) return; // closed or restarted meanwhile
    t3 = res;
    send.disabled = false;
    if (res.state !== "ok") {
      send.textContent = "Set up T3 Code…";
      if (res.state === "error") t3Status.textContent = res.error;
      return;
    }
    project.replaceChildren(...res.projects.map((p) => Object.assign(el("option", "", p.title), { value: p.id })));
    if (res.selectedId) project.value = res.selectedId;
    project.hidden = false;
    send.disabled = res.projects.length === 0;
    if (!res.projects.length) t3Status.textContent = "T3 Code has no projects yet.";
    parts.hint.textContent = "Add a comment · Enter copies · Ctrl+Enter sends to T3 Code · Esc cancels";
    placePanel();
  };

  const BLOCKED = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "auxclick", "touchstart", "touchmove", "touchend", "wheel"];
  const KEYS = ["keydown", "keypress", "keyup"];

  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    const opts = { capture: true, passive: false };
    window[method]("pointerdown", onPointerDown as EventListener, opts);
    window[method]("pointermove", onPointerMove as EventListener, opts);
    window[method]("pointerup", onPointerUp as EventListener, opts);
    window[method]("scroll", updateHover, opts);
    window[method]("resize", onResize, opts);
    for (const t of BLOCKED) window[method](t, block, opts);
    for (const t of KEYS) window[method](t, onKey as EventListener, opts);
  };

  const teardown = () => {
    phase = null;
    selection = null;
    dragStart = null;
    dragging = false;
    listen(false);
    if (host) unmountHost(host);
    host = null;
    parts = null;
    still = null;
    resumePage?.();
    resumePage = null;
  };

  const hideToast = () => {
    window.clearTimeout(toastTimer);
    if (toastHost) unmountHost(toastHost);
    if (toastImageUrl) URL.revokeObjectURL(toastImageUrl);
    toastHost = null;
    toastImageUrl = undefined;
  };

  const showToast = (message: string, image?: Blob, sticky = false) => {
    hideToast();
    const { host: th, root } = mountHost(["right: 16px", "bottom: 16px", "left: auto", "top: auto"]);
    toastHost = th;
    const toast = el("div", "toast");
    toast.setAttribute("role", "status");
    toast.append(el("div", "", message));
    if (image) {
      const img = el("img");
      img.alt = "Annotated screenshot";
      img.src = toastImageUrl = URL.createObjectURL(image);
      toast.append(img);
    }
    const close = el("button", "", "Close");
    close.addEventListener("click", hideToast);
    toast.append(close);
    root.append(toast);
    if (!sticky) toastTimer = window.setTimeout(hideToast, TOAST_MS);
  };

  /** Reads the selection, comment and still, then removes the overlay and resumes the page. */
  const takeAnnotation = (): { annotation: Annotation; still: string } | null => {
    if (!parts || !selection || !still) return null;
    const shot = still.dataUrl;
    const annotation: Annotation = {
      kind: selection.kind,
      rect: selection.rect,
      viewport: still.viewport,
      comment: parts.textarea.value.trim(),
      url: location.href,
      ...(selection.kind === "element" ? { element: selection.description } : {}),
    };
    teardown();
    return { annotation, still: shot };
  };

  const copy = () => {
    const taken = takeAnnotation();
    if (!taken) return;
    const { annotation } = taken;
    const png = renderAnnotation(taken.still, annotation);
    copyToClipboard(png, annotationText(annotation)).then(
      async () => showToast("Copied. Paste it into Claude Code or Codex.", await png),
      async (e: unknown) => {
        const image = await png.catch(() => undefined);
        const reason = e instanceof Error ? e.message : String(e);
        if (image) showToast(`Could not write to the clipboard (${reason}). Right-click the image → Copy image.`, image, true);
        else showToast(reason, undefined, true);
      },
    );
  };

  const sendToT3 = () => {
    if (!parts || t3?.state !== "ok") return;
    const projectId = parts.project.value;
    const projectTitle = parts.project.selectedOptions[0]?.textContent ?? "T3 Code";
    const taken = takeAnnotation();
    if (!taken || !projectId) return;
    const { annotation } = taken;
    void (async () => {
      let png: Blob | undefined;
      try {
        png = await renderAnnotation(taken.still, annotation);
        showToast(`Sending to ${projectTitle}…`, undefined, true);
        const res = await toWorker<T3SendResponse>({
          type: "t3/send",
          host: location.host,
          projectId,
          title: threadTitle(annotation.comment, annotation.url),
          text: annotationText(annotation),
          imageDataUrl: await blobToDataUrl(png),
          imageBytes: png.size,
        });
        if (!res.ok) throw new Error(res.error);
        showToast(`Started a T3 Code thread in ${projectTitle}.`, png);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (png) showToast(`Could not start the thread: ${reason} Right-click the image → Copy image to paste it yourself.`, png, true);
        else showToast(reason, undefined, true);
      }
    })();
  };

  /** Pauses the page and captures it once nothing of ours is on screen. */
  const freeze = async (): Promise<ImageBitmap> => {
    resumePage = pausePage();
    // Let the page repaint without the overlay or toast before the worker takes the screenshot.
    await nextFrames(2);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const dataUrl = await captureViewport();
    still = { dataUrl, viewport };
    return decodeDataUrl(dataUrl);
  };

  return {
    async start() {
      if (starting) return;
      starting = true;
      if (phase) teardown();
      hideToast();
      let bitmap: ImageBitmap;
      try {
        bitmap = await freeze();
      } catch (e) {
        teardown();
        showToast(e instanceof Error ? e.message : String(e), undefined, true);
        return;
      } finally {
        starting = false;
      }
      const mounted = mountHost([
        "inset: 0",
        "width: 100vw",
        "height: 100vh",
        "max-width: none",
        "max-height: none",
        "pointer-events: auto",
        "cursor: crosshair",
      ]);
      host = mounted.host;
      const layer = el("div", "layer");
      const canvas = el("canvas", "still");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const hint = el("div", "hint", "Page paused · Click an element or drag an area · Esc cancels");
      hint.setAttribute("role", "status");
      const panel = el("div", "panel");
      const textarea = el("textarea");
      textarea.placeholder = "What should change here?";
      textarea.setAttribute("aria-label", "Comment");
      const cancel = el("button", "", "Cancel");
      const copyButton = el("button", "primary", "Copy");
      cancel.addEventListener("click", teardown);
      copyButton.addEventListener("click", copy);
      const actions = el("div", "actions");
      actions.append(cancel, copyButton);
      const project = el("select");
      project.setAttribute("aria-label", "T3 Code project");
      const send = el("button", "", "Send to T3 Code");
      send.addEventListener("click", () => {
        if (t3?.state === "ok") sendToT3();
        else void toWorker({ type: "t3/setup" }).catch(() => undefined);
      });
      const t3Row = el("div", "t3");
      t3Row.append(project, send);
      const t3Status = el("div", "t3-status");
      t3Status.setAttribute("role", "status");
      panel.append(textarea, actions, t3Row, t3Status);
      const box = el("div", "box");
      const tag = el("div", "tag");
      layer.append(canvas, box, tag, hint, panel);
      mounted.root.append(layer);
      parts = { layer, box, tag, hint, panel, textarea, root: mounted.root, project, send, t3Status };
      phase = "select";
      listen(true);
    },
  };
}

if (!window.__screenshotAnnotator) {
  const overlay = createOverlay();
  window.__screenshotAnnotator = overlay;
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if ((raw as WorkerToContent)?.type !== "overlay/start") return false;
    void overlay.start();
    sendResponse({ ok: true });
    return false;
  });
}
