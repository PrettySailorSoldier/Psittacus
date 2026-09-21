/**
 * Recovers a page's *structure* from OCR geometry: which lines are chapter
 * titles, which are headings, which are body prose, and which are page
 * furniture (folios and running heads) that should not appear in a transcript
 * at all.
 *
 * WHY GEOMETRY AND NOT WORDING: "A Question of Timing" and "He had arrived
 * early" are indistinguishable as strings — both are ordinary English. What
 * separates them is that one is set 45% larger than the surrounding text. Every
 * distinction this module draws is therefore a measurement, never a guess from
 * vocabulary or capitalisation.
 *
 * This consumes the per-word boxes returned by `windows_ocr.rs`. Frames
 * answered by the vision-model fallback carry no geometry and cannot be
 * analysed here; the pipeline keeps their plain text instead.
 *
 * ASSUMES A CONSTANT CAPTURE SCALE. Body height is measured once across the
 * whole document rather than per page, which is what lets a chapter-opening
 * page — where the title may be the only line present — still be recognised as
 * a title rather than as the page's own idea of "normal size". That trade is
 * correct for a screen recording of a reader at a fixed zoom, and wrong if the
 * zoom level changes mid-recording.
 */

import type { OcrLineBox, OcrPageGeometry } from './ocr';

/** What a line turned out to be. */
export type LineRole = 'title' | 'heading' | 'body' | 'pageNumber' | 'runningHead';

export interface ClassifiedLine extends OcrLineBox {
  role: LineRole;
}

export interface PageStructure {
  lines: ClassifiedLine[];
  /** Folio recovered from this page, if one was found. */
  pageNumber: string | null;
}

/**
 * Height ratios, measured against the document's body height.
 *
 * Calibrated against real output rather than chosen: on a 1000x1400 page the
 * engine returned body at 22px, a section heading at 32px (1.45x) and a
 * chapter title at 40px (1.82x). The thresholds sit in the empty space between
 * those clusters, well clear of both.
 */
const TITLE_RATIO = 1.6;
const HEADING_RATIO = 1.2;

/**
 * Fraction of page height at the top and bottom treated as margin, where
 * folios and running heads live.
 *
 * The measured folio sat at y=1329 of 1400 — inside the bottom 5%. 8% leaves
 * room for looser layouts without reaching into the text block.
 */
const MARGIN_BAND = 0.08;

/** Longest a margin line can be and still be furniture rather than stray body text. */
const MAX_FURNITURE_WORDS = 8;

/**
 * How far from the page's horizontal centre a line may sit and still count as
 * centred, as a fraction of page width.
 *
 * The measured title spanned 278..720 on a 1000px page — centre 499 against a
 * page centre of 500, so real centring lands well inside this.
 */
const CENTRE_TOLERANCE = 0.06;

/**
 * A new paragraph starts when the vertical gap exceeds this multiple of body
 * height.
 *
 * Measured: consecutive lines within a paragraph were separated by 3–4px
 * against a 22px body height (0.15x), while the gap across a paragraph break
 * was 51px (2.3x). Anything in between is comfortably separated.
 */
const PARAGRAPH_GAP_RATIO = 0.6;

/** Indent, in multiples of body height, that marks a first line even without a gap. */
const INDENT_RATIO = 0.8;

const ROMAN_NUMERAL = /^m*(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Median of `values`, each weighted by the matching entry in `weights`.
 *
 * Weighting matters here. A plain median over line heights is pulled around by
 * how many headings a page happens to carry; weighting by word count lets body
 * prose — which is most of the words on any page — decide what "normal size"
 * means, even on a page that is mostly headings.
 */
function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;

  const pairs = values
    .map((value, i) => ({ value, weight: weights[i] }))
    .sort((a, b) => a.value - b.value);

  const total = pairs.reduce((sum, p) => sum + p.weight, 0);
  if (total === 0) return pairs[Math.floor(pairs.length / 2)].value;

  let seen = 0;
  for (const p of pairs) {
    seen += p.weight;
    if (seen >= total / 2) return p.value;
  }
  return pairs[pairs.length - 1].value;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Strip surrounding punctuation so `[142]` and `— 142 —` read as folios. */
function folioCandidate(text: string): string | null {
  const bare = text.trim().replace(/^[^\w]+|[^\w]+$/g, '');
  if (!bare) return null;
  if (/^\d{1,4}$/.test(bare)) return bare;
  if (ROMAN_NUMERAL.test(bare) && bare.length <= 7) return bare;
  return null;
}

/**
 * Document-wide facts a single page cannot establish on its own.
 */
export interface StructureContext {
  bodyHeight: number;
  /** Normalised margin-line texts that recur across pages — running heads. */
  runningHeads: Set<string>;
}

/**
 * Normalise a margin line for cross-page comparison.
 *
 * Digits are stripped because the folio is exactly the part that changes:
 * "142 THE SILENT GLAIVE" and "143 THE SILENT GLAIVE" are the same running
 * head, and comparing them literally would never match.
 */
function normaliseMarginLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\d]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fraction of pages a margin line must appear on to count as a running head.
 *
 * Running heads repeat on nearly every page by definition; a heading that
 * happens to sit high on one chapter-opening page does not.
 */
const RUNNING_HEAD_FREQUENCY = 0.4;

/**
 * Find running heads by looking across the whole document.
 *
 * NEEDED BECAUSE POSITION IS NOT ENOUGH. Measured on real output: a running
 * head sat at y=74 and a genuine `CHAPTER SEVEN` label at y=96 on a page of
 * the same height — 22px apart. No margin-band threshold separates those two
 * reliably. What does separate them is that one recurs on every page and the
 * other appears once.
 *
 * A running head carrying a folio ("143 THE SILENT GLAIVE") is caught by the
 * folio test instead and does not need to reach this frequency.
 */
function collectRunningHeads(pages: OcrPageGeometry[], marginBand: number): Set<string> {
  const counts = new Map<string, number>();

  for (const page of pages) {
    const topBand = page.imageHeight * marginBand;
    const bottomBand = page.imageHeight * (1 - marginBand);
    const seen = new Set<string>();

    for (const line of page.lines) {
      const inMargin = line.top < topBand || line.top + line.height > bottomBand;
      if (!inMargin) continue;
      const key = normaliseMarginLine(line.text);
      // An all-digit line normalises to nothing; it is a folio, handled by
      // pattern rather than by repetition.
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const minPages = Math.max(2, Math.ceil(pages.length * RUNNING_HEAD_FREQUENCY));
  return new Set([...counts].filter(([, n]) => n >= minPages).map(([key]) => key));
}

/**
 * Body text height for the whole document.
 *
 * Returns 0 when there is no geometry at all, which callers treat as "cannot
 * analyse" rather than as a measurement.
 */
export function documentBodyHeight(pages: OcrPageGeometry[]): number {
  const heights: number[] = [];
  const weights: number[] = [];

  for (const page of pages) {
    for (const line of page.lines) {
      const wordCount = words(line.text).length;
      if (wordCount === 0 || line.height <= 0) continue;
      heights.push(line.height);
      weights.push(wordCount);
    }
  }

  return weightedMedian(heights, weights);
}

/**
 * Classify every line on one page.
 *
 * `bodyHeight` comes from `documentBodyHeight` so the answer does not depend
 * on what happens to be on this particular page.
 */
export function analysePage(page: OcrPageGeometry, context: StructureContext): PageStructure {
  const { bodyHeight, runningHeads } = context;
  if (page.lines.length === 0 || bodyHeight <= 0) {
    return { lines: [], pageNumber: null };
  }

  const pageCentre = page.imageWidth / 2;
  const topBand = page.imageHeight * MARGIN_BAND;
  const bottomBand = page.imageHeight * (1 - MARGIN_BAND);

  // Where the text block starts. Taken from body-sized lines only, so a
  // centred title cannot drag the margin leftward.
  const bodyLefts = page.lines
    .filter(l => l.height <= bodyHeight * HEADING_RATIO)
    .map(l => l.left);
  const bodyLeft = bodyLefts.length > 0 ? median(bodyLefts) : median(page.lines.map(l => l.left));

  let pageNumber: string | null = null;

  const lines: ClassifiedLine[] = page.lines.map(line => {
    const lineWords = words(line.text);
    const inMargin = line.top < topBand || line.top + line.height > bottomBand;
    const ratio = line.height / bodyHeight;
    const centre = line.left + line.width / 2;
    const isCentred =
      Math.abs(centre - pageCentre) < page.imageWidth * CENTRE_TOLERANCE &&
      line.width < page.imageWidth * 0.75;

    // ── Page furniture ───────────────────────────────────────────────────────
    // Sitting in the margin band is necessary but NOT sufficient: a chapter
    // label can legitimately sit as high on the page as a running head does.
    // A margin line is only furniture if it also either reads as a folio or
    // recurs across the document. Everything else falls through and is judged
    // on its typography like any other line.
    if (inMargin && lineWords.length <= MAX_FURNITURE_WORDS) {
      const wholeLine = folioCandidate(line.text);
      if (wholeLine !== null) {
        pageNumber ??= wholeLine;
        return { ...line, role: 'pageNumber' };
      }

      // Running heads commonly carry the folio at one end: "142  THE SILENT
      // GLAIVE". Recover the number, then drop the whole line as furniture.
      const edgeFolio =
        folioCandidate(lineWords[0]) ?? folioCandidate(lineWords[lineWords.length - 1]);
      if (edgeFolio !== null) {
        pageNumber ??= edgeFolio;
        return { ...line, role: 'runningHead' };
      }

      if (runningHeads.has(normaliseMarginLine(line.text))) {
        return { ...line, role: 'runningHead' };
      }
    }

    // ── Headings, by measurement ─────────────────────────────────────────────
    if (ratio >= TITLE_RATIO) return { ...line, role: 'title' };
    if (ratio >= HEADING_RATIO) return { ...line, role: 'heading' };

    // A short centred line sitting outside the body margin is a heading even
    // when it is not set larger — small-caps chapter labels ("CHAPTER SEVEN")
    // are typically set at or below body size and would otherwise read as a
    // stray sentence in the middle of the prose.
    if (isCentred && lineWords.length <= MAX_FURNITURE_WORDS && line.left > bodyLeft + bodyHeight) {
      return { ...line, role: 'heading' };
    }

    return { ...line, role: 'body' };
  });

  return { lines, pageNumber };
}

/**
 * Join body lines into a paragraph, repairing words broken across a line end.
 *
 * Printed text hyphenates at the margin, and OCR faithfully returns the hyphen.
 * Joining naively yields "recog- nise"; this rejoins it. The lowercase test is
 * what keeps a genuine compound ("self-" / "Evident") from being welded shut.
 */
function joinBodyLines(lineTexts: string[]): string {
  let out = '';
  for (let i = 0; i < lineTexts.length; i++) {
    const current = lineTexts[i];
    const next = lineTexts[i + 1];
    const hyphenated = /[-‐]$/.test(current) && next !== undefined && /^[a-z]/.test(next);

    if (hyphenated) {
      out += current.replace(/[-‐]$/, '');
    } else {
      out += current + (next !== undefined ? ' ' : '');
    }
  }
  return out.trim();
}

/**
 * Render one analysed page as Markdown.
 *
 * Furniture is dropped: a folio and a running head repeat on every page of a
 * recording and are exactly the kind of interleaved noise that survives text
 * dedup, for the same reason `cropFrames` exists.
 */
export function renderPageMarkdown(structure: PageStructure, bodyHeight: number): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let previous: ClassifiedLine | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push(joinBodyLines(paragraph));
      paragraph = [];
    }
  };

  for (const line of structure.lines) {
    if (line.role === 'pageNumber' || line.role === 'runningHead') continue;

    if (line.role === 'title' || line.role === 'heading') {
      flush();
      blocks.push(`${line.role === 'title' ? '#' : '##'} ${line.text}`);
      previous = line;
      continue;
    }

    // Body. Decide whether this continues the current paragraph or starts one.
    if (previous !== null && previous.role === 'body') {
      const gap = line.top - (previous.top + previous.height);
      const indented = line.left > previous.left + bodyHeight * INDENT_RATIO;
      if (gap > bodyHeight * PARAGRAPH_GAP_RATIO || indented) flush();
    } else {
      flush();
    }

    paragraph.push(line.text.trim());
    previous = line;
  }

  flush();
  return blocks.join('\n\n');
}

/**
 * Analyse every frame and render each to Markdown.
 *
 * Returns one string per input page, aligned with `pages`, so the caller can
 * run the existing frame-level dedup over the result exactly as it does over
 * plain text. A page with no geometry yields `''`; the caller substitutes that
 * frame's plain OCR text.
 */
export function structurePages(pages: OcrPageGeometry[]): string[] {
  const bodyHeight = documentBodyHeight(pages);
  if (bodyHeight <= 0) return pages.map(() => '');

  const context: StructureContext = {
    bodyHeight,
    runningHeads: collectRunningHeads(pages, MARGIN_BAND),
  };

  return pages.map(page => renderPageMarkdown(analysePage(page, context), bodyHeight));
}
