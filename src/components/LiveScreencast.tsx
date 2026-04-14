import { useEffect, useRef, useState, useCallback } from "react";

interface LiveScreencastProps {
  onFirstFrame?: () => void;
  /** When true, captures mouse/keyboard/scroll on the canvas and forwards via CDP. */
  interactive?: boolean;
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
function getModifiers(e: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function mouseButton(e: MouseEvent): 'none' | 'left' | 'middle' | 'right' {
  if (e.button === 0) return 'left';
  if (e.button === 1) return 'middle';
  if (e.button === 2) return 'right';
  return 'none';
}

/** Map a key event to the text payload CDP expects for keyDown.
 *  Printable chars → the character itself.
 *  Special keys → their control character (Enter→\r, Tab→\t, Backspace→\b).
 *  Everything else → undefined (no text insertion). */
function keyText(key: string): string | undefined {
  if (key.length === 1) return key;
  switch (key) {
    case 'Enter': return '\r';
    case 'Tab': return '\t';
    case 'Backspace': return '\b';
    default: return undefined;
  }
}

/**
 * Renders a raw canvas that displays CDP screencast frames from the headless browser.
 * When `interactive` is true, also captures user input on the canvas and forwards it
 * to the headless browser via IPC → CDP Input.dispatch* commands.
 */
export function LiveScreencast({ onFirstFrame, interactive = false }: LiveScreencastProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizedRef = useRef(false);
  const endedRef = useRef(false);
  const [ready, setReady] = useState(false);

  // --- Frame subscription with coalescing ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctxRef.current = canvas.getContext("2d");
    endedRef.current = false;

    // Coalescing: keep only the latest frame. If a new frame arrives while the
    // previous is still decoding, the stale one is discarded on the next rAF.
    let latestData: string | null = null;
    let decoding = false;

    async function renderLatest() {
      if (decoding || endedRef.current) return;
      const data = latestData;
      if (!data) return;
      latestData = null;
      decoding = true;

      const ctx = ctxRef.current;
      if (!ctx) { decoding = false; return; }

      try {
        // Fast decode: atob → Uint8Array → Blob (skips fetch round-trip, ~5-15ms faster)
        const raw = atob(data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const bmp = await createImageBitmap(blob);

        if (endedRef.current) { bmp.close(); decoding = false; return; }

        if (!sizedRef.current) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.style.width = `${bmp.width}px`;
          canvas.style.height = `${bmp.height}px`;
          sizedRef.current = true;
          setReady(true);
          onFirstFrame?.();
        }

        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch {
        // Dropped frame — non-critical
      } finally {
        decoding = false;
        // If a newer frame arrived while we were decoding, render it next
        if (latestData) requestAnimationFrame(renderLatest);
      }
    }

    const unsubFrame = window.api.screencast.onFrame((data: string) => {
      if (endedRef.current) return;
      latestData = data; // Always overwrite — only the newest matters
      if (!decoding) requestAnimationFrame(renderLatest);
    });

    const unsubEnded = window.api.screencast.onEnded(() => {
      endedRef.current = true;
      latestData = null;
      const ctx = ctxRef.current;
      const c = canvasRef.current;
      if (ctx && c) {
        ctx.clearRect(0, 0, c.width, c.height);
      }
    });

    return () => {
      endedRef.current = true;
      latestData = null;
      unsubFrame();
      unsubEnded();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Interactive: input forwarding with drag + multi-click + selection support ---
  const getCanvasXY = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - rect.left, canvas.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, canvas.height)),
    };
  }, []);

  useEffect(() => {
    if (!interactive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.focus();

    // --- Drag state ---
    let dragging = false;
    let lastDragPos = { x: 0, y: 0 };

    // --- Multi-click detection (word / paragraph select) ---
    let clickCount = 0;
    let lastClickTime = 0;
    let lastClickPos = { x: 0, y: 0 };
    const MULTI_CLICK_TIME = 500; // ms
    const MULTI_CLICK_DIST = 5;  // px

    function computeClickCount(x: number, y: number): number {
      const now = Date.now();
      const dx = x - lastClickPos.x;
      const dy = y - lastClickPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (now - lastClickTime < MULTI_CLICK_TIME && dist < MULTI_CLICK_DIST) {
        clickCount = Math.min(clickCount + 1, 3); // cap at triple-click
      } else {
        clickCount = 1;
      }
      lastClickTime = now;
      lastClickPos = { x, y };
      return clickCount;
    }

    // --- Hover throttle (only when not dragging) ---
    let lastMoveTime = 0;
    const MOVE_THROTTLE = 1000 / 60; // ~16ms

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      canvas.focus();
      const { x, y } = getCanvasXY(e);
      const cc = computeClickCount(x, y);
      dragging = true;
      lastDragPos = { x, y };
      window.api.sendInput({
        type: 'mousePressed', x, y,
        button: mouseButton(e), buttons: 1,
        clickCount: cc, modifiers: getModifiers(e),
      });
      // Listen for mouseup on window to catch releases outside the canvas
      window.addEventListener('mouseup', onWindowMouseUp);
    };

    const onMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      const { x, y } = getCanvasXY(e);
      endDrag(x, y, e);
    };

    const onWindowMouseUp = (e: MouseEvent) => {
      // Fires if the user released outside the canvas during a drag
      if (!dragging) return;
      const { x, y } = getCanvasXY(e); // clamped to canvas bounds
      endDrag(x, y, e);
    };

    function endDrag(x: number, y: number, e: MouseEvent) {
      dragging = false;
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.api.sendInput({
        type: 'mouseReleased', x, y,
        button: mouseButton(e), buttons: 0,
        clickCount: clickCount, modifiers: getModifiers(e),
      });
    }

    const onMouseMove = (e: MouseEvent) => {
      if (dragging) {
        // During drag: forward every move with button held — critical for text selection
        const { x, y } = getCanvasXY(e);
        lastDragPos = { x, y };
        window.api.sendInput({
          type: 'mouseMoved', x, y,
          button: 'left', buttons: 1,
          modifiers: getModifiers(e),
        });
      } else {
        // Hover: throttle to 60Hz
        const now = Date.now();
        if (now - lastMoveTime < MOVE_THROTTLE) return;
        lastMoveTime = now;
        const { x, y } = getCanvasXY(e);
        window.api.sendInput({
          type: 'mouseMoved', x, y,
          button: 'none', buttons: 0,
          modifiers: getModifiers(e),
        });
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = getCanvasXY(e);
      window.api.sendInput({ type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;

      // Intercept Cmd+V / Ctrl+V — paste
      if (mod && key === 'v') { window.api.paste(); return; }

      // Intercept Cmd+C / Ctrl+C — copy selection from headless page
      if (mod && key === 'c') { window.api.copySelection(); return; }

      // Intercept Cmd+A / Ctrl+A — select all (forward as key event with Meta modifier)
      // Falls through to normal keyDown dispatch below, which handles modifiers correctly.

      const modifiers = getModifiers(e);
      window.api.sendInput({ type: 'keyDown', key: e.key, code: e.code, modifiers, text: keyText(e.key) });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      window.api.sendInput({ type: 'keyUp', key: e.key, code: e.code, modifiers: getModifiers(e) });
    };

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        window.api.paste(text);
      } else {
        window.api.paste();
      }
    };

    const onWindowClick = (e: Event) => {
      if (e.target !== canvas && canvas.closest('div')?.contains(e.target as Node)) {
        canvas.focus();
      }
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('paste', onPaste);
    document.addEventListener('click', onWindowClick);

    return () => {
      window.removeEventListener('mouseup', onWindowMouseUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('paste', onPaste);
      document.removeEventListener('click', onWindowClick);
    };
  }, [interactive, getCanvasXY]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={interactive ? 0 : undefined}
      style={{
        display: ready ? "block" : "none",
        outline: interactive ? "2px solid rgba(28, 28, 30, 0.15)" : undefined,
        cursor: interactive ? "default" : undefined,
        // When non-interactive (agent run), let clicks pass through to overlays (e.g. STOP button)
        pointerEvents: interactive ? "auto" : "none",
      }}
    />
  );
}
