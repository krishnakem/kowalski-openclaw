/**
 * Element Labeler — Set-of-Mark (SoM) overlay for VisionAgent screenshots.
 *
 * Detects interactive elements on the page via Playwright, draws numbered
 * labels on the screenshot (server-side via Jimp), and returns a map of
 * label → viewport-space bounding box for click execution.
 *
 * Stealth: all rendering happens on the screenshot buffer. No DOM
 * modifications, no injected scripts, no added elements.
 */

import { Jimp } from 'jimp';
import type { Page } from 'playwright';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LabeledElement {
    id: number;
    // Viewport-space bounding box (what GhostMouse needs)
    x: number;
    y: number;
    width: number;
    height: number;
    // Metadata for logging / text list
    tag: string;
    text: string;
    ariaLabel: string;
    href: string;
    role: string;  // ARIA role (e.g., "button", "link", "img")
}

export interface LabelResult {
    buffer: Buffer;
    elements: Map<number, LabeledElement>;
}

/** Raw element data returned from page.evaluate(). */
interface RawElement {
    tag: string;
    text: string;
    ariaLabel: string;
    href: string;
    role: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SIZE = 15;

// Safety: skip engagement buttons (defense-in-depth, English-only).
const SAFETY_LABEL_RE = /^(Like|Unlike|Save|Unsave|Share|Send|Follow|Unfollow|Direct|Comment|Reply)/i;

// Selectors that cover Instagram's interactive elements
// Note: [data-testid] removed — Instagram puts it on many non-interactive structural elements.
// [tabindex="0"] is handled separately with extra interactivity checks.
const SELECTOR = 'a, button, input, [role="button"], [role="link"], [tabindex="0"]';

// 3x5 pixel bitmaps for digits 0-9 (reused from gridOverlay)
const DIGIT_BITMAPS: number[][][] = [
    [[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]], // 0
    [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]], // 1
    [[1,1,1],[0,0,1],[1,1,1],[1,0,0],[1,1,1]], // 2
    [[1,1,1],[0,0,1],[1,1,1],[0,0,1],[1,1,1]], // 3
    [[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]], // 4
    [[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]], // 5
    [[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]], // 6
    [[1,1,1],[0,0,1],[0,0,1],[0,0,1],[0,0,1]], // 7
    [[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]], // 8
    [[1,1,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1]], // 9
];

const CHAR_W = 3;
const CHAR_H = 5;
const PIXEL_SCALE = 2;  // 6x10 px per digit
const CHAR_GAP = 1;
const BADGE_PAD = 2;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function labelElements(
    page: Page,
    screenshotBuffer: Buffer,
    screenshotWidth: number,
    screenshotHeight: number,
    viewportWidth: number,
    viewportHeight: number
): Promise<LabelResult> {
    // 1. Detect interactive elements via single page.evaluate()
    const rawElements = await detectElements(page, viewportWidth, viewportHeight);

    // 2. Filter: size, safety, dedup nested
    const filtered = filterAndDedup(rawElements);

    // 3. Sort top-to-bottom, left-to-right
    filtered.sort((a, b) => {
        const dy = a.y - b.y;
        return Math.abs(dy) > 20 ? dy : a.x - b.x;
    });

    // 4. Assign IDs (1-based) and build the element map
    const elements = new Map<number, LabeledElement>();
    for (let i = 0; i < filtered.length; i++) {
        const raw = filtered[i];
        const el: LabeledElement = {
            id: i + 1,
            x: raw.x,
            y: raw.y,
            width: raw.width,
            height: raw.height,
            tag: raw.tag,
            text: raw.text,
            ariaLabel: raw.ariaLabel,
            href: raw.href,
            role: raw.role,
        };
        elements.set(el.id, el);
    }

    // 5. Draw labels on the screenshot
    const buffer = await drawLabels(
        screenshotBuffer, elements,
        screenshotWidth, screenshotHeight,
        viewportWidth, viewportHeight
    );

    return { buffer, elements };
}

// ---------------------------------------------------------------------------
// Element Detection
// ---------------------------------------------------------------------------

async function detectElements(
    page: Page,
    viewportWidth: number,
    viewportHeight: number
): Promise<RawElement[]> {
    const { results, debug } = await page.evaluate(({ selector, vpW, vpH, safetyPattern }) => {
        const els = document.querySelectorAll(selector);
        const results: Array<{
            tag: string; text: string; ariaLabel: string; href: string; role: string;
            x: number; y: number; width: number; height: number;
        }> = [];
        const debug: string[] = [];

        // Tags that are inherently interactive (don't need extra checks)
        const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
        const safetyRe = new RegExp(safetyPattern, 'i');

        for (const el of els) {
            const htmlEl = el as HTMLElement;
            const rect = htmlEl.getBoundingClientRect();

            // Skip invisible or off-screen
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) continue;
            if (rect.x >= vpW || rect.y >= vpH) continue;

            // Skip elements that cover >15% of viewport (containers, not buttons/links).
            // Story containers, post image wrappers, etc. are ~20-35% of viewport.
            // No legitimate interactive target (button, link, arrow) exceeds ~10%.
            if (rect.width * rect.height > vpW * vpH * 0.15) continue;

            // Visibility check via computed style
            const style = window.getComputedStyle(htmlEl);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            if (parseFloat(style.opacity) < 0.1) continue;
            if (style.pointerEvents === 'none') continue;

            // For tabindex="0" elements that aren't inherently interactive and have no
            // role="button"|"link", require cursor:pointer to prove interactivity.
            // This filters out structural containers Instagram marks with tabindex="0".
            const tag = el.tagName;
            const role = el.getAttribute('role') || '';
            if (!INTERACTIVE_TAGS.has(tag) && role !== 'button' && role !== 'link') {
                if (style.cursor !== 'pointer') continue;
            }

            // Safety: skip engagement buttons (Like, Follow, Share, Save, etc.).
            // Check the element AND its descendants — Instagram often puts aria-label
            // on an inner <svg> rather than the outer <button>.
            const selfLabel = el.getAttribute('aria-label') || '';
            let isSafety = safetyRe.test(selfLabel);
            if (!isSafety) {
                const inner = htmlEl.querySelector('[aria-label]');
                if (inner) {
                    const innerLabel = inner.getAttribute('aria-label') || '';
                    isSafety = safetyRe.test(innerLabel);
                }
            }
            if (isSafety) continue;

            // Context filter: skip elements inside dense scrollable containers.
            // Comment sections, tagged-user lists, and similar repeating UI have a
            // scrollable ancestor packed with interactive children. Navigation buttons,
            // close buttons, and sidebar items are never inside such containers.
            // Exception: <a> tags linking to posts, reels, or stories are always kept —
            // these are high-value navigation links (e.g. timestamp links to open post modals).
            const href = el.getAttribute('href') || '';
            if (tag === 'A' && (/\/p\//.test(href) || /\/reel\//.test(href))) {
                debug.push(`Found /p/ link: href="${href}" text="${(el.textContent||'').trim().slice(0,30)}" size=${rect.width}x${rect.height}`);
            }
            const isNavLink = tag === 'A' && /^\/(.*\/)?p\/|\/reel\/|\/stories\//.test(href);
            // Carousel navigation arrows (Next/Previous buttons inside post modals)
            // and close/dismiss buttons must bypass the dense-scroller filter.
            // Detection: aria-label match OR absolutely-positioned small buttons
            // (carousel arrows are position:absolute over the image; comment buttons are in flow).
            const isOverlayBtn = (tag === 'BUTTON' || role === 'button') && style.position === 'absolute';
            const isCarouselOrCloseBtn = ((tag === 'BUTTON' || role === 'button') &&
                /^(Next|Go Forward|Go Back|Previous|Close|Chevron)/i.test(selfLabel)) || isOverlayBtn;
            if (!isNavLink && !isCarouselOrCloseBtn) {
                let inDenseScroller = false;
                let ancestor = htmlEl.parentElement;
                for (let depth = 0; depth < 8 && ancestor; depth++) {
                    const aStyle = window.getComputedStyle(ancestor);
                    const scrollable = aStyle.overflowY === 'auto' || aStyle.overflowY === 'scroll';
                    if (scrollable) {
                        const childCount = ancestor.querySelectorAll('a, button').length;
                        if (childCount > 10) {
                            inDenseScroller = true;
                            break;
                        }
                    }
                    ancestor = ancestor.parentElement;
                }
                if (inDenseScroller) continue;
            }

            results.push({
                tag: tag.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 50),
                ariaLabel: selfLabel,
                href: el.getAttribute('href') || '',
                role: role,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
        }
        return { results, debug };
    }, { selector: SELECTOR, vpW: viewportWidth, vpH: viewportHeight, safetyPattern: SAFETY_LABEL_RE.source });

    if (debug.length > 0) {
        console.log(`  🔍 detectElements debug (${debug.length} /p/ or /reel/ links found in DOM):`);
        for (const line of debug) {
            console.log(`     ${line}`);
        }
    } else {
        console.log('  🔍 detectElements debug: NO /p/ or /reel/ links found in DOM');
    }

    return results;
}

// ---------------------------------------------------------------------------
// Filtering & Dedup
// ---------------------------------------------------------------------------

function filterAndDedup(elements: RawElement[]): RawElement[] {
    // Size filter — exempt /p/ and /reel/ links (timestamp links are small but critical)
    let filtered = elements.filter(el => {
        const isPostLink = el.tag === 'a' && (/\/p\//.test(el.href) || /\/reel\//.test(el.href));
        return isPostLink || (el.width >= MIN_SIZE && el.height >= MIN_SIZE);
    });

    // Nested element dedup: when two elements overlap >80%, keep the inner (smaller) one
    const kept: RawElement[] = [];
    for (const el of filtered) {
        let isRedundantOuter = false;
        // Check if this element is the outer wrapper of an already-kept inner element
        for (const existing of kept) {
            const overlap = computeOverlap(el, existing);
            if (overlap > 0.8) {
                const elArea = el.width * el.height;
                const existingArea = existing.width * existing.height;
                if (elArea >= existingArea) {
                    // el is the outer/larger one, existing is inner → skip el
                    isRedundantOuter = true;
                    break;
                }
            }
        }
        if (isRedundantOuter) continue;

        // Check if a previously kept element is the outer wrapper of this new inner element
        for (let i = kept.length - 1; i >= 0; i--) {
            const existing = kept[i];
            const overlap = computeOverlap(existing, el);
            if (overlap > 0.8) {
                const elArea = el.width * el.height;
                const existingArea = existing.width * existing.height;
                if (existingArea >= elArea) {
                    // existing is the outer/larger one → remove it
                    kept.splice(i, 1);
                }
            }
        }

        kept.push(el);
    }

    return kept;
}

/** Compute how much of elementA is covered by elementB (0-1). */
function computeOverlap(a: RawElement, b: RawElement): number {
    const overlapX = Math.max(0,
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    );
    const overlapY = Math.max(0,
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    );
    const overlapArea = overlapX * overlapY;
    const aArea = a.width * a.height;
    return aArea > 0 ? overlapArea / aArea : 0;
}

// ---------------------------------------------------------------------------
// Label Drawing
// ---------------------------------------------------------------------------

async function drawLabels(
    screenshotBuffer: Buffer,
    elements: Map<number, LabeledElement>,
    screenshotWidth: number,
    screenshotHeight: number,
    viewportWidth: number,
    viewportHeight: number
): Promise<Buffer> {
    const image = await Jimp.read(Buffer.from(screenshotBuffer));
    const { width: imgW, height: imgH, data } = image.bitmap;

    // Scale factor from viewport to screenshot space
    const scaleX = screenshotWidth / viewportWidth;
    const scaleY = screenshotHeight / viewportHeight;

    // Track placed badge rectangles for collision avoidance
    const placedBadges: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const [, el] of elements) {
        // Convert bounding box to screenshot space
        const sx = Math.round(el.x * scaleX);
        const sy = Math.round(el.y * scaleY);
        const sw = Math.round(el.width * scaleX);
        const sh = Math.round(el.height * scaleY);

        // Draw thin green border around element
        drawRect(data, imgW, imgH, sx, sy, sw, sh, 0, 180, 0, 0.4);

        // Calculate badge dimensions
        const text = String(el.id);
        const scaledCharW = CHAR_W * PIXEL_SCALE;
        const scaledCharH = CHAR_H * PIXEL_SCALE;
        const badgeW = text.length * (scaledCharW + CHAR_GAP) - CHAR_GAP + BADGE_PAD * 2;
        const badgeH = scaledCharH + BADGE_PAD * 2;

        // Default badge position: just above the top-left of the element
        let badgeX = sx;
        let badgeY = sy - badgeH - 1;

        // If badge would be above the image, place it inside the top of the element
        if (badgeY < 0) badgeY = sy + 1;

        // Collision avoidance: shift right or below if overlapping another badge
        for (let attempt = 0; attempt < 3; attempt++) {
            const collides = placedBadges.some(b =>
                badgeX < b.x + b.w && badgeX + badgeW > b.x &&
                badgeY < b.y + b.h && badgeY + badgeH > b.y
            );
            if (!collides) break;
            if (attempt === 0) {
                // Try shifting right
                badgeX = sx + sw - badgeW;
            } else if (attempt === 1) {
                // Try below the element
                badgeX = sx;
                badgeY = sy + sh + 1;
            }
            // attempt 2: give up, place as-is (slight overlap is OK)
        }

        placedBadges.push({ x: badgeX, y: badgeY, w: badgeW, h: badgeH });

        // Draw badge background (dark, semi-opaque)
        drawFilledRect(data, imgW, imgH, badgeX, badgeY, badgeW, badgeH, 0, 0, 0, 0.75);

        // Draw digits in white
        let cx = badgeX + BADGE_PAD;
        const digitY = badgeY + BADGE_PAD;
        for (const ch of text) {
            const digit = parseInt(ch, 10);
            if (digit >= 0 && digit <= 9) {
                drawDigit(data, imgW, imgH, DIGIT_BITMAPS[digit], cx, digitY, 255, 255, 255);
            }
            cx += scaledCharW + CHAR_GAP;
        }
    }

    return await image.getBuffer('image/jpeg', { quality: 80 });
}

// ---------------------------------------------------------------------------
// Pixel Drawing Helpers
// ---------------------------------------------------------------------------

/** Draw a 1px border rectangle (semi-transparent blend). */
function drawRect(
    data: Buffer, imgW: number, imgH: number,
    x: number, y: number, w: number, h: number,
    r: number, g: number, b: number, opacity: number
): void {
    const keep = 1 - opacity;
    // Top and bottom edges
    for (let dx = 0; dx < w; dx++) {
        blendPixel(data, imgW, imgH, x + dx, y, r, g, b, keep, opacity);
        blendPixel(data, imgW, imgH, x + dx, y + h - 1, r, g, b, keep, opacity);
    }
    // Left and right edges
    for (let dy = 1; dy < h - 1; dy++) {
        blendPixel(data, imgW, imgH, x, y + dy, r, g, b, keep, opacity);
        blendPixel(data, imgW, imgH, x + w - 1, y + dy, r, g, b, keep, opacity);
    }
}

/** Draw a filled rectangle (semi-transparent blend). */
function drawFilledRect(
    data: Buffer, imgW: number, imgH: number,
    x: number, y: number, w: number, h: number,
    r: number, g: number, b: number, opacity: number
): void {
    const keep = 1 - opacity;
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            blendPixel(data, imgW, imgH, x + dx, y + dy, r, g, b, keep, opacity);
        }
    }
}

/** Blend a single pixel. */
function blendPixel(
    data: Buffer, imgW: number, imgH: number,
    px: number, py: number,
    r: number, g: number, b: number,
    keep: number, opacity: number
): void {
    if (px < 0 || px >= imgW || py < 0 || py >= imgH) return;
    const idx = (py * imgW + px) * 4;
    data[idx]     = Math.round(data[idx]     * keep + r * opacity);
    data[idx + 1] = Math.round(data[idx + 1] * keep + g * opacity);
    data[idx + 2] = Math.round(data[idx + 2] * keep + b * opacity);
}

/** Draw a single digit using a 3x5 bitmap, scaled by PIXEL_SCALE. */
function drawDigit(
    data: Buffer, imgW: number, imgH: number,
    bitmap: number[][], startX: number, startY: number,
    r: number, g: number, b: number
): void {
    for (let row = 0; row < CHAR_H; row++) {
        for (let col = 0; col < CHAR_W; col++) {
            if (bitmap[row][col]) {
                for (let sy = 0; sy < PIXEL_SCALE; sy++) {
                    for (let sx = 0; sx < PIXEL_SCALE; sx++) {
                        const px = startX + col * PIXEL_SCALE + sx;
                        const py = startY + row * PIXEL_SCALE + sy;
                        if (px >= 0 && px < imgW && py >= 0 && py < imgH) {
                            const idx = (py * imgW + px) * 4;
                            data[idx]     = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                        }
                    }
                }
            }
        }
    }
}
