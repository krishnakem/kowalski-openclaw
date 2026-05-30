/**
 * Text-only PDF export for Instagram digest records.
 *
 * Called from `run_digest` right before it returns. Renders the digest's
 * editorial `markdown` (preferred) or falls back to the legacy `sections`
 * representation, writes the result as a paginated A4 PDF into the user's
 * Downloads folder, and returns the absolute path.
 *
 * Typography: headings are set in Instrument Serif and body text in Source
 * Serif 4 (both bundled under assets/fonts). Emoji runs are switched to
 * Noto Emoji mid-line because PDFKit has no built-in font fallback — its
 * default WinAnsi-encoded Helvetica mangles any codepoint outside Latin-1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { AnalysisObject, ArchivedAnalysis } from '../types/analysis.js';

export interface DigestPdfOptions {
    /** Override output directory (defaults to ~/Downloads). */
    downloadsDir?: string;
    /** Set true when the run stopped early or timed out to add a partial-run banner. */
    aborted?: boolean;
    /** Optional abortReason — rendered as a user-facing reason when aborted is true. */
    abortReason?: string;
}

const FONTS_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONT = {
    heading: 'Heading',
    headingItalic: 'HeadingItalic',
    body: 'Body',
    bodyBold: 'BodyBold',
    bodyItalic: 'BodyItalic',
    emoji: 'Emoji',
} as const;

/**
 * Render the digest to a PDF and return the written path.
 * Non-throwing on directory-creation failures — callers treat the return
 * value as optional and omit it from the tool-response header on failure.
 */
export async function writeDigestPdf(
    record: ArchivedAnalysis,
    opts: DigestPdfOptions = {}
): Promise<string> {
    const downloadsDir = opts.downloadsDir ?? path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });

    const now = new Date();
    const stamp = formatStamp(now);
    const filename = `kowalski-digest-${stamp.file}.pdf`;
    const outPath = path.join(downloadsDir, filename);

    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        info: {
            Title: record.data.title || 'Kowalski Instagram digest',
            Author: 'Kowalski (OpenClaw plugin)',
            Subject: 'Instagram digest',
            CreationDate: new Date(),
        },
    });
    registerFonts(doc);
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // --- Banner for partial runs ---
    if (opts.aborted) {
        doc.fillColor('#aa2200');
        emitPlain(
            doc,
            `⚠ PARTIAL DIGEST — ${partialRunLabel(opts.abortReason)}`,
            FONT.bodyBold,
            11
        );
        doc.moveDown(0.5).fillColor('black');
    }

    // --- Header ---
    emitPlain(doc, record.data.title || 'Instagram digest', FONT.heading, 24);
    if (record.data.subtitle) {
        doc.moveDown(0.15).fillColor('#555');
        emitPlain(doc, record.data.subtitle, FONT.headingItalic, 13);
        doc.fillColor('black');
    }
    const metaBits: string[] = [stamp.display];
    if (record.data.location) metaBits.push(record.data.location);
    doc.moveDown(0.4).fillColor('#888');
    emitPlain(doc, metaBits.join(' · '), FONT.body, 9);
    doc.fillColor('black').moveDown(1);

    // --- Body ---
    if (record.data.markdown && record.data.markdown.trim()) {
        renderMarkdown(doc, record.data.markdown);
    } else {
        renderSections(doc, record.data);
    }

    doc.end();
    await new Promise<void>((resolve, reject) => {
        stream.on('finish', () => resolve());
        stream.on('error', reject);
    });
    return outPath;
}

function partialRunLabel(reason?: string): string {
    switch (reason) {
        case 'user-stop':
            return 'run stopped early by request';
        case 'timeout-stories':
            return 'stories phase timed out';
        case 'timeout-feed':
            return 'feed phase timed out';
        case 'offline':
            return 'network interrupted the run';
        default:
            return reason ? `run ended early (${reason})` : 'run ended early';
    }
}

function registerFonts(doc: PDFKit.PDFDocument): void {
    doc.registerFont(FONT.heading, path.join(FONTS_DIR, 'InstrumentSerif-Regular.ttf'));
    doc.registerFont(FONT.headingItalic, path.join(FONTS_DIR, 'InstrumentSerif-Italic.ttf'));
    doc.registerFont(FONT.body, path.join(FONTS_DIR, 'SourceSerif4-Regular.ttf'));
    doc.registerFont(FONT.bodyBold, path.join(FONTS_DIR, 'SourceSerif4-Bold.ttf'));
    doc.registerFont(FONT.bodyItalic, path.join(FONTS_DIR, 'SourceSerif4-It.ttf'));
    doc.registerFont(FONT.emoji, path.join(FONTS_DIR, 'NotoEmoji-Regular.ttf'));
}

// ---------------------------------------------------------------------------
// Minimal Markdown renderer — tuned for the digest prompt's output shape.
// Handles: # / ## / ### headers, leading `- ` bullets, **bold**, *italic*,
// `inline code`. Everything else is emitted as plain text with wrapping
// preserved.
// ---------------------------------------------------------------------------
function renderMarkdown(doc: PDFKit.PDFDocument, md: string): void {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === '') {
            doc.moveDown(0.4);
            continue;
        }
        const h1 = line.match(/^#\s+(.*)$/);
        const h2 = line.match(/^##\s+(.*)$/);
        const h3 = line.match(/^###\s+(.*)$/);
        const bullet = line.match(/^[-*]\s+(.*)$/);
        if (h1) {
            doc.moveDown(0.4);
            emitInline(doc, h1[1], FONT.heading, 22);
            doc.moveDown(0.2);
            continue;
        }
        if (h2) {
            doc.moveDown(0.3);
            emitInline(doc, h2[1], FONT.heading, 16);
            doc.moveDown(0.15);
            continue;
        }
        if (h3) {
            doc.moveDown(0.25);
            emitInline(doc, h3[1], FONT.heading, 13);
            doc.moveDown(0.1);
            continue;
        }
        if (bullet) {
            emitInline(doc, '• ' + bullet[1], FONT.body, 10.5);
            continue;
        }
        emitInline(doc, line, FONT.body, 10.5);
    }
}

function renderSections(doc: PDFKit.PDFDocument, data: AnalysisObject): void {
    for (const section of data.sections ?? []) {
        doc.moveDown(0.5);
        emitInline(doc, section.heading, FONT.heading, 16);
        doc.moveDown(0.15);
        for (const para of section.content ?? []) {
            emitInline(doc, para, FONT.body, 10.5);
            doc.moveDown(0.3);
        }
    }
}

/**
 * Render a single line of inline markdown (**bold**, *italic*, `code`) with
 * emoji runs swapped to Noto Emoji. `baseFont` picks the right family for
 * plain/bold/italic depending on whether we're in a heading or body context.
 */
function emitInline(
    doc: PDFKit.PDFDocument,
    text: string,
    baseFont: string,
    size: number
): void {
    const tokens = tokenizeInline(text);
    const runs: StyledRun[] = [];
    for (const tok of tokens) {
        const styleFont = fontForToken(tok.kind, baseFont);
        for (const part of splitEmojiRuns(tok.text)) {
            runs.push({ font: part.emoji ? FONT.emoji : styleFont, text: part.text });
        }
    }
    layoutRuns(doc, runs, size);
}

/** No markdown parsing — just split for emoji and lay out. */
function emitPlain(
    doc: PDFKit.PDFDocument,
    text: string,
    baseFont: string,
    size: number
): void {
    const runs: StyledRun[] = splitEmojiRuns(text).map((p) => ({
        font: p.emoji ? FONT.emoji : baseFont,
        text: p.text,
    }));
    layoutRuns(doc, runs, size);
}

interface StyledRun {
    font: string;
    text: string;
}

/**
 * Manually lay out a sequence of styled runs into wrapped lines.
 *
 * PDFKit's `continued: true` chain assumes all runs share the first run's
 * line metrics; swapping fonts mid-chain (e.g., proportional → Courier for
 * inline code) causes runs that wrap to render at the wrong baseline, so
 * they overlap the preceding line. Doing our own word-level layout and
 * emitting each run with absolute x/y sidesteps the issue entirely.
 *
 * Each "word" keeps its trailing whitespace so a run boundary in the middle
 * of a word (e.g., `**bold**word`) stays glued together on the same line.
 * Line-height is the max of every font used, so tall glyphs (Noto Emoji,
 * Instrument Serif headings) don't clip.
 */
function layoutRuns(doc: PDFKit.PDFDocument, runs: StyledRun[], size: number): void {
    doc.fontSize(size);

    const words: StyledRun[] = [];
    for (const r of runs) {
        if (!r.text) continue;
        const matches = r.text.match(/\S+\s*|\s+/g) ?? [];
        for (const m of matches) words.push({ font: r.font, text: m });
    }
    if (words.length === 0) return;

    let lineHeight = 0;
    for (const f of new Set(words.map((w) => w.font))) {
        doc.font(f);
        lineHeight = Math.max(lineHeight, doc.currentLineHeight(true));
    }

    const leftMargin = doc.page.margins.left;
    const rightMargin = doc.page.margins.right;
    const fullWidth = doc.page.width - leftMargin - rightMargin;
    const startX = doc.x;
    const firstAvail = doc.page.width - rightMargin - startX;

    const lines: StyledRun[][] = [[]];
    let curWidth = 0;
    let onFirstLine = true;
    for (const w of words) {
        doc.font(w.font);
        const ww = doc.widthOfString(w.text);
        const avail = onFirstLine ? firstAvail : fullWidth;
        const line = lines[lines.length - 1];
        if (line.length === 0) {
            line.push(w);
            curWidth = ww;
            continue;
        }
        if (curWidth + ww > avail) {
            lines.push([w]);
            curWidth = ww;
            onFirstLine = false;
        } else {
            line.push(w);
            curWidth += ww;
        }
    }

    const pageBottom = doc.page.height - doc.page.margins.bottom;
    let x = startX;
    let y = doc.y;
    lines.forEach((line, idx) => {
        if (idx > 0) {
            y += lineHeight;
            x = leftMargin;
        }
        if (y + lineHeight > pageBottom) {
            doc.addPage();
            y = doc.page.margins.top;
            x = leftMargin;
        }
        for (const w of line) {
            doc.font(w.font);
            doc.text(w.text, x, y, { lineBreak: false });
            x += doc.widthOfString(w.text);
        }
    });

    doc.x = leftMargin;
    doc.y = y + lineHeight;
}

function fontForToken(kind: InlineToken['kind'], baseFont: string): string {
    const isHeading = baseFont === FONT.heading;
    switch (kind) {
        case 'bold':
            return isHeading ? FONT.heading : FONT.bodyBold;
        case 'italic':
            return isHeading ? FONT.headingItalic : FONT.bodyItalic;
        case 'code':
            return 'Courier';
        default:
            return baseFont;
    }
}

interface InlineToken {
    kind: 'plain' | 'bold' | 'italic' | 'code';
    text: string;
}

function tokenizeInline(text: string): InlineToken[] {
    const out: InlineToken[] = [];
    let i = 0;
    let buf = '';
    const flush = () => {
        if (buf) {
            out.push({ kind: 'plain', text: buf });
            buf = '';
        }
    };
    while (i < text.length) {
        const rest = text.slice(i);
        const bold = rest.match(/^\*\*([^*]+)\*\*/);
        if (bold) {
            flush();
            out.push({ kind: 'bold', text: bold[1] });
            i += bold[0].length;
            continue;
        }
        const italic = rest.match(/^\*([^*]+)\*/);
        if (italic) {
            flush();
            out.push({ kind: 'italic', text: italic[1] });
            i += italic[0].length;
            continue;
        }
        const code = rest.match(/^`([^`]+)`/);
        if (code) {
            flush();
            out.push({ kind: 'code', text: code[1] });
            i += code[0].length;
            continue;
        }
        buf += text[i];
        i += 1;
    }
    flush();
    // PDFKit needs at least one token to avoid a zero-height paragraph.
    return out.length ? out : [{ kind: 'plain', text: '' }];
}

// Split a string into alternating text/emoji runs so we can swap to the
// Noto Emoji font for emoji segments. Covers the main emoji blocks plus the
// trailing variation-selector / ZWJ codepoints that sometimes glue onto them.
const EMOJI_RE =
    /(?:[\u{1F000}-\u{1FFFF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}\u{200D}]?)+/gu;

function splitEmojiRuns(text: string): Array<{ text: string; emoji: boolean }> {
    const runs: Array<{ text: string; emoji: boolean }> = [];
    let last = 0;
    for (const m of text.matchAll(EMOJI_RE)) {
        const idx = m.index ?? 0;
        if (idx > last) runs.push({ text: text.slice(last, idx), emoji: false });
        runs.push({ text: m[0], emoji: true });
        last = idx + m[0].length;
    }
    if (last < text.length) runs.push({ text: text.slice(last), emoji: false });
    return runs.length ? runs : [{ text, emoji: false }];
}

function formatStamp(d: Date): { display: string; file: string } {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return {
        display: `${y}-${m}-${day} ${hh}:${mm}`,
        file: `${y}-${m}-${day}-${hh}${mm}`,
    };
}
