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
 *
 * List nesting levels are likewise taken from where list items sit across the
 * whole document, so a frame that scrolled past a list's parent item still
 * indents its nested items. That assumes the page does not shift sideways
 * between frames, which a fixed crop of a scrolling reader guarantees.
 */

import type { OcrLineBox, OcrPageGeometry } from './ocr';

/**
 * What a line turned out to be.
 *
 *   subheading — a numbered/lettered heading set at body size ("2. Buyer's Breach")
 *   callout    — emphasised text set slightly larger than body (a boxed rule)
 *   listItem   — one entry of a numbered, lettered or bulleted list
 *   sideText   — stray words beside the prose, e.g. text inside a figure
 *   tocEntry   — a table-of-contents line ending in a page reference
 *   tableRow   — one row of cells sitting side by side (see `arrangeLines`)
 *   clipped    — a line cut off by the frame edge and read as garbage
 */
export type LineRole =
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'callout'
  | 'listItem'
  | 'tocEntry'
  | 'tableRow'
  | 'pageNumber'
  | 'runningHead'
  | 'sideText'
  | 'clipped';

/** A line in reading order. Table rows carry their cells, left to right. */
export interface ArrangedLine extends OcrLineBox {
  cells?: string[];
  /**
   * The line's list marker sat apart from its text, in a column of its own.
   * That is how list markup is typeset; a sentence that happens to open with
   * "7." is not set that way, so such a line is a list item even alone.
   */
  hangingMarker?: boolean;
}

export interface ClassifiedLine extends ArrangedLine {
  role: LineRole;
  /** Type size relative to body text; see `lineSize`. */
  size: number;
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
export const HEADING_RATIO = 1.2;

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
 * height — the floor of the threshold, see `PARAGRAPH_GAP_MARGIN`.
 *
 * Measured: consecutive lines within a paragraph were separated by 3–4px
 * against a 22px body height (0.15x), while the gap across a paragraph break
 * was 51px (2.3x). Anything in between is comfortably separated.
 */
const PARAGRAPH_GAP_RATIO = 0.6;

/**
 * How far past the document's ordinary line gap, in body heights, a gap must
 * reach to count as a paragraph break.
 *
 * NEEDED BECAUSE LEADING VARIES. The ratio above was set on a tightly-leaded
 * book. A web page set at 1.6 line height measured 17px between lines of 25px
 * text (0.68x) — over that ratio — so every line came out as a paragraph of
 * its own. The paragraph breaks on the same page were 36px. Measuring the
 * ordinary line gap per document and adding this margin separates both
 * layouts: the book's threshold stays where it was.
 */
const PARAGRAPH_GAP_MARGIN = 0.4;

/** Indent, in multiples of body height, that marks a first line even without a gap. */
const INDENT_RATIO = 0.8;

const ROMAN_NUMERAL = /^m*(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

/**
 * Height ratio at which a body-width line counts as a callout.
 *
 * Measured on a law textbook: body lines 21px, the italic boxed rule
 * statements 24px (1.14x), bold-italic subheadings 22px (1.05x). The threshold
 * sits between the subheadings and the callouts, and below HEADING_RATIO.
 *
 * A callout's last line can measure at body height when it happens to have no
 * descenders ("Code § 1790.3]." came back at 21px), so the renderer keeps a
 * callout paragraph going across such a line rather than relying on this
 * ratio for every line.
 */
const CALLOUT_RATIO = 1.1;

/**
 * Outline markers that open a subheading: "II.", "A.", "3.".
 *
 * Needed because size alone misses them. In the measured textbook, numbered
 * subheadings are set bold-italic at body size (22px against 21px), so no
 * height threshold separates them from prose without also catching callouts.
 */
const OUTLINE_MARKER = /^(?:[IVXLC]+|[A-Za-z]|\d{1,2})\.\s+\S/;

/**
 * A table-of-contents entry: ends in a page reference, "(p. 441)" or a dot
 * leader run to a number. On a real chapter outline these were merged into
 * run-on paragraphs ("… (p. 441) 4. No Movement of Goods Required (p. 442)")
 * because consecutive entries sit as close together as lines of prose.
 */
const TOC_ENTRY = /(?:\(p{1,2}\.?\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?\)|\.{3,}\s*\d{1,4})\s*$/;

/** Splits a line holding several entries, after each page reference. */
const TOC_SPLIT = /(?<=\(p{1,2}\.?\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?\))\s+(?=\S)/;

/** Longest line, in words, still treated as a subheading. */
const SUBHEADING_MAX_WORDS = 12;

/** Widest a subheading may be, as a fraction of the page's widest body line. */
const SUBHEADING_MAX_WIDTH = 0.75;

/** List markers: "1." "1)" "a." "a)" and common bullet glyphs. */
const LIST_MARKER = /^(\d{1,2}[.)]|[A-Za-z][.)]|[•●▪◦·*–-])\s+\S/;

/**
 * Side text: at most this many words, sitting beside (not within) a line of
 * prose, separated from it by at least `SIDE_TEXT_MIN_GAP_RATIO` body heights.
 *
 * This is what text wrapped around a picture looks like when the picture
 * itself contains words. Measured: a word-cloud image beside a wrapped
 * paragraph yielded "uctEA", "customari" and "*3days", each level with a prose
 * line ending 230px to their left.
 *
 * Kept to short fragments next to real prose so a second text column (long
 * lines) is never mistaken for it.
 */
const SIDE_TEXT_MAX_WORDS = 3;
const SIDE_TEXT_NEIGHBOUR_MIN_WORDS = 6;
const SIDE_TEXT_MIN_GAP_RATIO = 2;

/**
 * A list marker standing alone on its line.
 *
 * Windows OCR returns a hanging list marker as a separate line, and returns
 * the whole column of them before the text they belong to. Measured on a web
 * page: "1." … "7." came back as seven lines, then the seven items.
 */
const MARKER_ONLY = /^(?:\d{1,2}|[A-Za-z]|[IVXLC]{1,4})[.)]$|^[•●▪◦·*–-]$/;

/** Furthest a lone marker may sit from its text, in body heights. */
const MARKER_MAX_GAP_RATIO = 3;

/**
 * Pairs of long side-by-side lines that mark a page as multi-column. Below
 * this the page is read row by row; at or above it the engine's own order,
 * which already walks one column at a time, is kept.
 */
const MULTI_COLUMN_MIN_PAIRS = 3;

/** Longest cell, in words, a table row may hold — longer is a column of prose. */
const TABLE_CELL_MAX_WORDS = 8;

/** A table needs one column of short cells (labels, figures) at least this short. */
const TABLE_SHORT_CELL_WORDS = 3;

/**
 * Longest line, in words, that can be promoted to a heading for standing
 * apart from its neighbours (see the heading pass in `refineBodyLines`).
 */
const STANDALONE_HEADING_MAX_WORDS = 10;

/**
 * Smallest size a centred line may have and still be a chapter label. Keeps
 * the small print inside a picture (a report title in a screenshot) out.
 */
const CENTRED_HEADING_MIN_SIZE = 0.9;

/**
 * A line counts as touching the frame edge within this many body heights.
 *
 * A line the frame cuts through comes back as the part the engine could see,
 * and its box runs to the edge. On a real run these read "your ume unu
 * cureJuuy your cnutces." and "tranqartinn« for theqe rprpint«".
 */
const EDGE_TOLERANCE_RATIO = 0.15;

/** Share of tokens that must be words for an edge line to be kept. */
const CLIPPED_MIN_WORD_SHARE = 0.75;

/** Fewest body words of a letter shape needed to trust its median height. */
const MIN_SHAPE_SAMPLES = 8;

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
 * Document-wide measurements every page is judged against.
 */
export interface DocumentMetrics {
  /** Median line height of body text, weighted by words. */
  bodyHeight: number;
  /** Median height of words of each letter shape; see `shapeClass`. */
  shapeHeights: Map<string, number>;
  /** Ordinary vertical gap between lines of one paragraph. */
  lineGap: number;
  /** Vertical gap above which consecutive lines belong to separate paragraphs. */
  paragraphGap: number;
}

/**
 * Document-wide facts a single page cannot establish on its own.
 */
export interface StructureContext extends DocumentMetrics {
  /** Normalised margin-line texts that recur across pages — running heads. */
  runningHeads: Set<string>;
  /**
   * Dictionary lookup, when one is available. Side text is only dropped when
   * it fails this test; without it, nothing is dropped as side text.
   */
  isWord?: (word: string) => boolean;
}

/**
 * Whether a short fragment reads as junk rather than language: fewer than
 * half its tokens are words or numbers.
 *
 * Position alone was not enough. Text inside a picture ("uctEA", "*3days")
 * sits beside the prose — but so do the "FACTS:" and "DECISION: McDANIEL,
 * Justice" labels of a case excerpt, and on a real run those were deleted
 * along with the junk.
 */
function looksLikeJunk(text: string, isWord: (word: string) => boolean): boolean {
  return wordShare(text, isWord) < 0.5;
}

/** Share of a line's tokens that are words or numbers; 0 for a line with none. */
function wordShare(text: string, isWord: (word: string) => boolean): number {
  const tokens = words(text)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  if (tokens.length === 0) return 0;
  const wordlike = tokens.filter(t =>
    /^[\d.,()§-]+$/.test(t) || isWord(t) || isWord(t.replace(/['’]s$/, ''))
  ).length;
  return wordlike / tokens.length;
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
    const edges = edgeLines(page.lines);
    const seen = new Set<string>();

    for (const line of page.lines) {
      const inMargin = line.top < topBand || line.top + line.height > bottomBand;
      if (!inMargin && !edges.has(line)) continue;
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
 * The topmost and bottommost lines of a page.
 *
 * NEEDED BECAUSE THE MARGIN BAND ASSUMES A TIGHT CROP. On a real run the crop
 * left enough space above the page that "CHAPTER 14" and "SALES LAW: RISK OF
 * LOSS AND WARRANTIES" sat below the top 8% on most frames, so neither was
 * ever considered, and both were printed once per page. Whatever the crop,
 * a running head is still the first line on its page.
 *
 * Being an edge line only makes a line a *candidate*; it still has to recur
 * across the document, or read as a bare page number, to be dropped.
 */
function edgeLines<T extends OcrLineBox>(lines: T[]): Set<T> {
  if (lines.length === 0) return new Set();
  let top = lines[0];
  let bottom = lines[0];
  for (const line of lines) {
    if (line.top < top.top) top = line;
    if (line.top + line.height > bottom.top + bottom.height) bottom = line;
  }
  return new Set([top, bottom]);
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
 * Which letter shapes a word contains, as a key: how high it reaches
 * (`T` capitals, digits and full ascenders; `i` the dot of an i; `t` the
 * short stem of a t; `x` x-height only), plus `d` if it reaches below the
 * baseline.
 *
 * WHY: a word's box is tight to its glyphs, so its height says as much about
 * its letters as about its type size. Measured on one line of 26px body text:
 * "on" 13px, "to" 16px, "the" 20px, "for" 25px. Comparing each word against
 * body words of the same shape takes the letters out of the measurement.
 */
function shapeClass(word: string): string {
  const reach = /[A-Z0-9bdfhkl$&#%@?!/\\|()[\]{}]/.test(word)
    ? 'T'
    : /i/.test(word) ? 'i' : /t/.test(word) ? 't' : 'x';
  return /[gjpqy,;$@|()[\]{}]/.test(word) ? `${reach}d` : reach;
}

/**
 * Size of a line's type relative to body text: 1 for body, ~1.5 for a section
 * heading.
 *
 * The median, over the line's words, of each word's height against body words
 * of the same shape. Two failures of the line's union box this avoids, both
 * measured on a real page: a heading with no descenders ("Add and Edit
 * Vendors") came back shorter than body lines that had them, and a sentence
 * with one bold word in a taller face cleared the callout threshold.
 *
 * Falls back to the line box when the line carries no word geometry.
 */
export function lineSize(line: OcrLineBox, metrics: DocumentMetrics): number {
  const ratios: number[] = [];
  for (const word of line.words ?? []) {
    const reference = metrics.shapeHeights.get(shapeClass(word.text));
    if (reference && word.height > 0) ratios.push(word.height / reference);
  }
  if (ratios.length > 0) return median(ratios);
  return metrics.bodyHeight > 0 ? line.height / metrics.bodyHeight : 1;
}

/**
 * Measure the document: body height, the height of each letter shape, and
 * the gap that separates paragraphs.
 *
 * Gaps are sampled between vertically consecutive body-sized lines that
 * overlap horizontally, so a neighbouring column or a margin note does not
 * count as "the next line". Most such pairs are lines of one paragraph, so the
 * median is the ordinary line gap.
 */
export function documentMetrics(pages: OcrPageGeometry[]): DocumentMetrics {
  const bodyHeight = documentBodyHeight(pages);

  const byShape = new Map<string, number[]>();
  for (const page of pages) {
    for (const line of page.lines) {
      for (const word of line.words ?? []) {
        if (word.height <= 0) continue;
        const key = shapeClass(word.text);
        const list = byShape.get(key) ?? [];
        list.push(word.height);
        byShape.set(key, list);
      }
    }
  }
  const shapeHeights = new Map<string, number>();
  for (const [key, heights] of byShape) {
    if (heights.length >= MIN_SHAPE_SAMPLES) shapeHeights.set(key, median(heights));
  }

  const gaps: number[] = [];
  for (const page of pages) {
    const lines = page.lines
      .filter(l =>
        words(l.text).length >= 3 &&
        l.height >= bodyHeight * 0.7 &&
        l.height <= bodyHeight * 1.4
      )
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < lines.length; i++) {
      const above = lines[i - 1];
      const below = lines[i];
      const overlaps =
        below.left < above.left + above.width && above.left < below.left + below.width;
      const gap = gapBetween(above, below);
      if (overlaps && gap > -bodyHeight * 0.5 && gap < bodyHeight * 3) gaps.push(gap);
    }
  }
  const lineGap = gaps.length > 0 ? median(gaps) : 0;
  const paragraphGap = Math.max(
    bodyHeight * PARAGRAPH_GAP_RATIO,
    gaps.length > 0 ? lineGap + bodyHeight * PARAGRAPH_GAP_MARGIN : 0
  );

  return { bodyHeight, shapeHeights, lineGap, paragraphGap };
}

/** Whether two lines sit on the same row: their vertical centres nearly agree. */
function sameRow(a: OcrLineBox, b: OcrLineBox): boolean {
  const centreA = a.top + a.height / 2;
  const centreB = b.top + b.height / 2;
  return Math.abs(centreA - centreB) <= Math.min(a.height, b.height) * 0.5;
}

/** The union of two lines' boxes, carrying both lines' words. */
function unionBox(a: OcrLineBox, b: OcrLineBox, text: string): OcrLineBox {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return {
    text,
    left,
    top,
    width: right - left,
    height: bottom - top,
    words: [...(a.words ?? []), ...(b.words ?? [])],
  };
}

/**
 * Re-attach each lone list marker to the line it numbers.
 *
 * The marker is joined to the nearest line on its row to its right. One with
 * no such line (a marker whose text the engine missed) is left as it is.
 */
function attachMarkers(lines: OcrLineBox[], bodyHeight: number): ArrangedLine[] {
  const out: ArrangedLine[] = [...lines];
  for (const marker of lines) {
    if (!MARKER_ONLY.test(marker.text.trim())) continue;
    const markerRight = marker.left + marker.width;

    let target = -1;
    out.forEach((line, i) => {
      if (line === marker || MARKER_ONLY.test(line.text.trim())) return;
      const gap = line.left - markerRight;
      if (gap < -marker.width * 0.5 || gap > bodyHeight * MARKER_MAX_GAP_RATIO) return;
      if (!sameRow(marker, line)) return;
      if (target === -1 || line.left < out[target].left) target = i;
    });
    if (target === -1) continue;

    out[target] = {
      ...unionBox(marker, out[target], `${marker.text.trim()} ${out[target].text.trim()}`),
      hangingMarker: true,
    };
    out.splice(out.indexOf(marker), 1);
  }
  return out;
}

/** Group lines into rows, top to bottom, each row's lines left to right. */
function groupRows<T extends OcrLineBox>(lines: T[]): T[][] {
  const sorted = [...lines].sort((a, b) => (a.top + a.height / 2) - (b.top + b.height / 2));
  const rows: T[][] = [];
  for (const line of sorted) {
    const row = rows[rows.length - 1];
    if (row && sameRow(row[0], line)) row.push(line);
    else rows.push([line]);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows;
}

/**
 * Whether the page is set in several columns of prose: long lines sitting
 * side by side on the same row, again and again.
 */
function isMultiColumn(rows: OcrLineBox[][]): boolean {
  const pairs = rows.filter(row => row.filter(l => words(l.text).length >= 6).length >= 2).length;
  return pairs >= MULTI_COLUMN_MIN_PAIRS;
}

/** Whether `row` can continue a table whose previous row is `previous`. */
function continuesTable(previous: OcrLineBox[], row: OcrLineBox[]): boolean {
  if (row.length !== previous.length) return false;
  // Each cell overlaps the cell above it horizontally. Overlap rather than a
  // shared edge, because a column of figures is right-aligned and a "TOTAL"
  // label may be outdented from the labels above it.
  return row.every((cell, i) => {
    const above = previous[i];
    return cell.left < above.left + above.width && above.left < cell.left + cell.width;
  });
}

const DECIMAL_FIGURE = /^\(?[$€£]?-?[\d,]+\.\d{2}\)?$/;

/**
 * Restore decimal points the engine dropped from a column of money.
 *
 * Measured on a report screenshot: "250.00" read as "25000" and "16.84" as
 * "16 84", in a column whose other cells read "48.96" and "$315.80". Enlarging
 * the image before re-reading did not bring the points back. A cell is only
 * repaired when at least two others in its column show the two-decimal format.
 */
function repairFigureColumns(rows: string[][]): void {
  const columns = rows[0]?.length ?? 0;
  for (let c = 0; c < columns; c++) {
    const formatted = rows.filter(row => DECIMAL_FIGURE.test(row[c])).length;
    if (formatted < 2) continue;
    for (const row of rows) {
      row[c] = row[c].replace(/^([$€£]?\d+) ?(\d{2})$/, '$1.$2');
    }
  }
}

/**
 * Put a page's lines into reading order, re-attach list markers, and gather
 * tables into rows.
 *
 * WHY: Windows OCR returns lines block by block, not row by row. A column of
 * list markers, or the figures column of a table, comes back as one block
 * after the text beside it. On a real page "1." … "7." were all returned
 * before the first item, and a two-column table came back as every label and
 * then every amount.
 *
 * A single-column page is re-read row by row. A page of several prose columns
 * keeps the engine's order, which walks each column in turn; reading it row by
 * row would interleave them.
 */
export function arrangeLines(lines: OcrLineBox[], bodyHeight: number): ArrangedLine[] {
  const attached = attachMarkers(lines, bodyHeight);
  const rows = groupRows(attached);
  if (isMultiColumn(rows)) return attached;

  const out: ArrangedLine[] = [];
  let i = 0;
  while (i < rows.length) {
    // The longest run of rows, from here, that reads as a table.
    let end = i;
    while (
      end < rows.length &&
      rows[end].length >= 2 &&
      rows[end].every(cell => words(cell.text).length <= TABLE_CELL_MAX_WORDS) &&
      (end === i || continuesTable(rows[end - 1], rows[end]))
    ) {
      end++;
    }

    const run = rows.slice(i, end);
    const hasShortColumn =
      run.length > 0 &&
      run[0].some((_, c) => run.every(row => words(row[c].text).length <= TABLE_SHORT_CELL_WORDS));

    if (run.length >= 2 && hasShortColumn) {
      const cells = run.map(row => row.map(cell => cell.text.trim()));
      repairFigureColumns(cells);
      run.forEach((row, r) => {
        const box = row.reduce((acc, cell) => unionBox(acc, cell, ''));
        out.push({ ...box, text: cells[r].join(' | '), cells: cells[r] });
      });
      i = end;
    } else {
      out.push(...rows[i]);
      i++;
    }
  }
  return out;
}

/**
 * Classify every line on one page.
 *
 * `bodyHeight` comes from `documentBodyHeight` so the answer does not depend
 * on what happens to be on this particular page.
 */
export function analysePage(page: OcrPageGeometry, context: StructureContext): PageStructure {
  const { bodyHeight, runningHeads, isWord } = context;
  if (page.lines.length === 0 || bodyHeight <= 0) {
    return { lines: [], pageNumber: null };
  }

  const pageCentre = page.imageWidth / 2;
  const topBand = page.imageHeight * MARGIN_BAND;
  const bottomBand = page.imageHeight * (1 - MARGIN_BAND);
  const edgeTolerance = Math.max(2, bodyHeight * EDGE_TOLERANCE_RATIO);
  const arranged = arrangeLines(page.lines, bodyHeight);

  // Where the text block starts. Taken from body-sized lines only, so a
  // centred title cannot drag the margin leftward.
  const bodyLefts = arranged
    .filter(l => lineSize(l, context) < HEADING_RATIO)
    .map(l => l.left);
  const bodyLeft = bodyLefts.length > 0 ? median(bodyLefts) : median(arranged.map(l => l.left));

  let pageNumber: string | null = null;
  const edges = edgeLines(arranged);

  const lines: ClassifiedLine[] = arranged.map(line => {
    const lineWords = words(line.text);
    const inMargin = line.top < topBand || line.top + line.height > bottomBand;
    const atEdge = edges.has(line);
    const ratio = lineSize(line, context);
    const centre = line.left + line.width / 2;
    const isCentred =
      Math.abs(centre - pageCentre) < page.imageWidth * CENTRE_TOLERANCE &&
      line.width < page.imageWidth * 0.75;
    const classify = (role: LineRole): ClassifiedLine => ({ ...line, role, size: ratio });

    if (line.cells) return classify('tableRow');

    // ── Cut by the frame edge ────────────────────────────────────────────────
    // Only dropped when it also reads as garbage: a cut line the engine still
    // read correctly costs nothing to keep. A dropped one is not lost — the
    // next or previous frame of a scroll shows it whole, and stitching takes
    // it from there.
    const touchesEdge =
      line.top <= edgeTolerance || line.top + line.height >= page.imageHeight - edgeTolerance;
    if (touchesEdge && isWord && wordShare(line.text, isWord) < CLIPPED_MIN_WORD_SHARE) {
      return classify('clipped');
    }

    // ── Page furniture ───────────────────────────────────────────────────────
    // Sitting in the margin band is necessary but NOT sufficient: a chapter
    // label can legitimately sit as high on the page as a running head does.
    // A margin line is only furniture if it also either reads as a folio or
    // recurs across the document. Everything else falls through and is judged
    // on its typography like any other line.
    if ((inMargin || atEdge) && lineWords.length <= MAX_FURNITURE_WORDS) {
      const wholeLine = folioCandidate(line.text);
      if (wholeLine !== null) {
        pageNumber ??= wholeLine;
        return classify('pageNumber');
      }

      // Running heads commonly carry the folio at one end: "142  THE SILENT
      // GLAIVE". Recover the number, then drop the whole line as furniture.
      // Margin band only: an edge line outside it is just as likely to be a
      // numbered subheading ("4. No Movement of Goods Required") that happens
      // to open the frame, and this test would throw it away.
      const edgeFolio = inMargin
        ? folioCandidate(lineWords[0]) ?? folioCandidate(lineWords[lineWords.length - 1])
        : null;
      if (edgeFolio !== null) {
        pageNumber ??= edgeFolio;
        return classify('runningHead');
      }

      if (runningHeads.has(normaliseMarginLine(line.text))) {
        return classify('runningHead');
      }
    }

    // ── Table of contents ────────────────────────────────────────────────────
    // Ahead of the size tests: an outline entry set in capitals ("VI. TERMS
    // (p. 461)") measures as a heading, and was rendered as one.
    if (TOC_ENTRY.test(line.text)) return classify('tocEntry');

    // ── Headings, by measurement ─────────────────────────────────────────────
    // A heading never starts in lowercase. Without this guard a paragraph's
    // last word, alone on its line ("not.", "buyer."), was promoted to a
    // heading on a real run.
    const startsLowercase = /^[a-z]/.test(line.text.trim());
    if (!startsLowercase) {
      if (ratio >= TITLE_RATIO) return classify('title');
      if (ratio >= HEADING_RATIO) return classify('heading');

      // A short centred line sitting outside the body margin is a heading even
      // when it is not set larger — small-caps chapter labels ("CHAPTER SEVEN")
      // are typically set at or below body size and would otherwise read as a
      // stray sentence in the middle of the prose.
      if (
        isCentred &&
        lineWords.length <= MAX_FURNITURE_WORDS &&
        line.left > bodyLeft + bodyHeight &&
        ratio >= CENTRED_HEADING_MIN_SIZE
      ) {
        return classify('heading');
      }
    }

    return classify('body');
  });

  refineBodyLines(lines, context);

  return { lines, pageNumber };
}

/** Vertical gap between the bottom of `above` and the top of `below`. */
function gapBetween(above: OcrLineBox, below: OcrLineBox): number {
  return below.top - (above.top + above.height);
}

/** Position of a list marker in its sequence (1, 2, 3 / a, b, c), or null for bullets. */
function markerOrdinal(text: string): number | null {
  const marker = text.trim().split(/\s+/)[0].replace(/[.)]$/, '');
  if (/^\d+$/.test(marker)) return parseInt(marker, 10);
  if (/^[a-z]$/i.test(marker)) return marker.toLowerCase().charCodeAt(0) - 96;
  return null;
}

/** A bullet glyph no line of prose opens with, unlike "-" or "*". */
const UNAMBIGUOUS_BULLET = /^[•●▪◦]\s/;

/**
 * Mark the list items in one run of body lines.
 *
 * Markers are grouped by left edge, one group per nesting level, so a bulleted
 * list inside a numbered one is found as two lists rather than rejected as
 * misaligned. Within a level, numbered or lettered markers must count up by
 * one, in sequences of two or more. Prose wrapping so that two lines both
 * happen to start with "2)" and "3)" is possible; prose doing that in sequence
 * at the same indent is not something real paragraphs do.
 */
function markListItems(run: ClassifiedLine[], bodyHeight: number): void {
  const markers = run.filter(l => LIST_MARKER.test(l.text.trim()));
  const tolerance = bodyHeight * 0.5;
  for (const left of clusterLefts(markers.map(l => l.left), tolerance)) {
    markListLevel(markers.filter(l => Math.abs(l.left - left) <= tolerance));
  }

  // A lone numbered line followed by a list nested under it is that list's
  // parent item ("1. Review the list:" / "• Debit card …"), even with no
  // sibling to count from.
  run.forEach((line, i) => {
    const next = run[i + 1];
    if (line.role === 'body' && LIST_MARKER.test(line.text.trim()) &&
        next?.role === 'listItem' && next.left > line.left + tolerance) {
      line.role = 'listItem';
    }
  });
}

/** Mark the list items among the markers of one indent level, in order. */
function markListLevel(markers: ClassifiedLine[]): void {
  const bullets = markers.filter(l => markerOrdinal(l.text) === null);
  for (const line of bullets) {
    if (bullets.length >= 2 || line.hangingMarker || UNAMBIGUOUS_BULLET.test(line.text.trim())) {
      line.role = 'listItem';
    }
  }

  const numbered = markers.filter(l => markerOrdinal(l.text) !== null);
  let sequence: ClassifiedLine[] = [];
  let previous = 0;
  const close = () => {
    if (sequence.length >= 2 || sequence.every(l => l.hangingMarker)) {
      for (const line of sequence) line.role = 'listItem';
    }
    sequence = [];
  };

  numbered.forEach((line, i) => {
    let ordinal = markerOrdinal(line.text)!;

    // A "1." read as "I." or "l." — the letter ordinal would be 9 or 12. When
    // the next marker is 2 it can only have been a 1; repair the text as well,
    // or the list renders as "I. … / 2. …".
    const next = numbered[i + 1];
    if (sequence.length === 0 && /^[Il][.)]\s/.test(line.text.trim()) &&
        next !== undefined && markerOrdinal(next.text) === 2) {
      ordinal = 1;
      line.text = line.text.trim().replace(/^[Il]/, '1');
    }

    if (sequence.length > 0 && ordinal !== previous + 1) close();
    sequence.push(line);
    previous = ordinal;
  });
  close();
}

function isHeadingRole(role: LineRole): boolean {
  return role === 'title' || role === 'heading' || role === 'subheading';
}

/**
 * Second pass over a classified page: the distinctions that need a line's
 * neighbours, not just its own measurements.
 *
 * Order matters. Side text goes first so a figure fragment cannot split a
 * list run or count as the line before a subheading; lists go before
 * subheadings because "1. Good title," inside a list also looks like an
 * outline marker.
 */
function refineBodyLines(lines: ClassifiedLine[], context: StructureContext): void {
  const { bodyHeight, lineGap, paragraphGap, isWord } = context;

  // ── Table of contents ──────────────────────────────────────────────────────
  // One line ending in "(p. 12)" is a cross-reference in prose; a contents
  // page has them line after line. The last page of a contents list can carry
  // as few as two entries, so two is the bar.
  if (lines.filter(l => l.role === 'tocEntry').length < 2) {
    for (const line of lines) if (line.role === 'tocEntry') line.role = 'body';
  }

  // ── Side text ──────────────────────────────────────────────────────────────
  const isProse = (l: ClassifiedLine) =>
    l.role === 'body' && words(l.text).length >= SIDE_TEXT_NEIGHBOUR_MIN_WORDS;

  for (const line of lines) {
    if (line.role !== 'body' || words(line.text).length > SIDE_TEXT_MAX_WORDS) continue;
    if (!isWord || !looksLikeJunk(line.text, isWord)) continue;
    const besideProse = lines.some(other => {
      if (other === line || !isProse(other)) return false;
      const overlapsVertically =
        line.top < other.top + other.height && other.top < line.top + line.height;
      const horizontalGap = Math.max(
        line.left - (other.left + other.width),
        other.left - (line.left + line.width)
      );
      return overlapsVertically && horizontalGap >= bodyHeight * SIDE_TEXT_MIN_GAP_RATIO;
    });
    if (besideProse) line.role = 'sideText';
  }

  // Lines in reading order that actually render.
  const flow = lines.filter(l => !isDropped(l.role));

  // ── Lists ──────────────────────────────────────────────────────────────────
  // Runs break at headings and other non-body lines, not at vertical gaps: a
  // web page spaces list items further apart than lines of a paragraph, and
  // splitting there left every item alone in its run, never forming a list.
  let runStart = 0;
  for (let i = 1; i <= flow.length; i++) {
    const runEnds = i === flow.length || flow[i].role !== 'body' || flow[i - 1].role !== 'body';
    if (!runEnds) continue;
    markListItems(flow.slice(runStart, i), bodyHeight);
    runStart = i;
  }

  // ── Subheadings ────────────────────────────────────────────────────────────
  const widestBody = Math.max(0, ...flow.filter(l => l.role === 'body').map(l => l.width));

  flow.forEach((line, i) => {
    if (line.role !== 'body') return;
    const text = line.text.trim();
    if (!OUTLINE_MARKER.test(text)) return;
    if (words(text).length > SUBHEADING_MAX_WORDS) return;
    // A heading does not end mid-sentence or as a question; a list entry,
    // prose line or numbered study question ("1. Who is a consignor?") does.
    if (/[.,;:?!]$/.test(text)) return;
    if (line.width > widestBody * SUBHEADING_MAX_WIDTH) return;

    const previous = flow[i - 1];
    const setApart =
      previous === undefined ||
      isHeadingRole(previous.role) ||
      gapBetween(previous, line) > paragraphGap;
    if (setApart) line.role = 'subheading';
  });

  // ── Headings that stand alone ──────────────────────────────────────────────
  // A short line with space above and below, set a little larger than body
  // or in capitals, is a heading even below HEADING_RATIO. Measured on a web
  // page: section titles at 1.2x body and "APPLY YOUR SKILLS 4-1" banners at
  // body size, both distinguished on screen by colour and weight, which OCR
  // does not report. A callout or prose line ends in punctuation and runs on.
  //
  // The space below need only clear the ordinary line gap, not a paragraph
  // break: a heading sits close to the text it introduces. Measured: 26px
  // under "Prepare Report and Pay Bills" against 17px between body lines and
  // a 27px paragraph threshold.
  const headingGapBelow = lineGap + bodyHeight * 0.25;
  flow.forEach((line, i) => {
    if (line.role !== 'body') return;
    const text = line.text.trim();
    if (words(text).length > STANDALONE_HEADING_MAX_WORDS) return;
    if (!/^[A-Z0-9]/.test(text) || /[.,;:?!]$/.test(text)) return;

    const letters = text.replace(/[^A-Za-z]/g, '');
    const capitals = letters.length >= 3 && letters === letters.toUpperCase();
    if (line.size < CALLOUT_RATIO && !capitals) return;

    const previous = flow[i - 1];
    const next = flow[i + 1];
    const apartAbove =
      previous === undefined || isHeadingRole(previous.role) || gapBetween(previous, line) > paragraphGap;
    const apartBelow = next === undefined || gapBetween(line, next) > headingGapBelow;
    if (apartAbove && apartBelow) line.role = 'heading';
  });

  // ── Callouts ───────────────────────────────────────────────────────────────
  for (const line of flow) {
    if (line.role === 'body' && line.size >= CALLOUT_RATIO) line.role = 'callout';
  }
}

/** Roles that never render. */
function isDropped(role: LineRole): boolean {
  return role === 'pageNumber' || role === 'runningHead' || role === 'sideText' || role === 'clipped';
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

/** One list item: its indent level and its paragraphs, each a run of lines. */
interface ListItem {
  level: number;
  paragraphs: string[][];
}

/**
 * Render one analysed page as Markdown.
 *
 * Furniture is dropped: a folio and a running head repeat on every page of a
 * recording and are exactly the kind of interleaved noise that survives text
 * dedup, for the same reason `cropFrames` exists.
 *
 * `listLefts` are the left edges of each list nesting level, outermost first.
 * Taken from this page alone when not given; `structurePages` passes the
 * whole document's, because a frame that scrolled past a list's parent item
 * shows only the nested items and would otherwise render them unindented.
 */
export function renderPageMarkdown(
  structure: PageStructure,
  metrics: DocumentMetrics,
  listLefts: number[] = listLevelLefts([structure], metrics.bodyHeight)
): string {
  const { bodyHeight, paragraphGap } = metrics;
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let paragraphKind: 'body' | 'callout' = 'body';
  let listItems: ListItem[] = [];
  let itemLeft = 0;
  let tableRows: string[][] = [];
  let previous: ClassifiedLine | null = null;
  // Index in `blocks` of a heading that a following line may continue.
  let openHeading = -1;

  // Contents entries: indent level from where each entry starts, so the
  // outline's nesting survives (I. → A. → 1. → a.).
  const tocLefts = clusterLefts(
    structure.lines.filter(l => l.role === 'tocEntry').map(l => l.left),
    bodyHeight * 0.7
  );
  let tocBlock: string[] = [];
  const flushToc = () => {
    if (tocBlock.length > 0) {
      blocks.push(tocBlock.join('\n'));
      tocBlock = [];
    }
  };

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const text = joinBodyLines(paragraph);
      blocks.push(paragraphKind === 'callout' ? `> ${text}` : text);
      paragraph = [];
    }
  };

  // Items joined by single newlines so Markdown renders one list, not several.
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(listItems.map(formatListItem).join('\n'));
      listItems = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length > 0) {
      blocks.push(formatTable(tableRows));
      tableRows = [];
    }
  };

  for (const line of structure.lines) {
    if (isDropped(line.role)) continue;
    const text = line.text.trim();

    if (line.role === 'tableRow') {
      flushParagraph();
      flushList();
      flushToc();
      openHeading = -1;
      // A row with a different number of cells starts a new table.
      if (tableRows.length > 0 && tableRows[0].length !== line.cells!.length) flushTable();
      tableRows.push(line.cells!);
      previous = line;
      continue;
    }
    flushTable();

    if (line.role === 'tocEntry') {
      flushParagraph();
      flushList();
      openHeading = -1;
      const level = tocLefts.findIndex(left => Math.abs(left - line.left) <= bodyHeight * 0.7);
      for (const entry of text.split(TOC_SPLIT)) {
        tocBlock.push(`${'  '.repeat(Math.max(0, level))}- ${entry.trim()}`);
      }
      previous = line;
      continue;
    }
    flushToc();

    if (isHeadingRole(line.role)) {
      flushParagraph();
      flushList();

      // A title set over several lines ("Sales Law: / Risk of Loss and /
      // Warranties") is one heading, not three. Continue the open heading
      // when this line has the same role and follows within a line's height.
      const continuesHeading =
        openHeading >= 0 &&
        previous !== null &&
        previous.role === line.role &&
        line.role !== 'subheading' &&
        line.top - (previous.top + previous.height) <= previous.height;

      if (continuesHeading) {
        blocks[openHeading] += ` ${text}`;
      } else {
        blocks.push(`${headingPrefix(line)} ${text}`);
        openHeading = blocks.length - 1;
      }
      previous = line;
      continue;
    }
    openHeading = -1;

    const gap = previous !== null ? line.top - (previous.top + previous.height) : Infinity;
    const adjacent = gap <= paragraphGap;

    if (line.role === 'listItem') {
      flushParagraph();
      const level = listLefts.findIndex(left => Math.abs(left - line.left) <= bodyHeight * 0.5);
      listItems.push({ level: Math.max(0, level), paragraphs: [[text]] });
      itemLeft = line.left;
      previous = line;
      continue;
    }

    // A wrapped list item continues under its text, to the right of the
    // marker. A line under it after a paragraph's worth of space is a further
    // paragraph of the same item ("Edit the vendor:" / "GPM@email.net"); one
    // further away than that has left the list.
    if (listItems.length > 0 && line.role === 'body' && gap <= paragraphGap * 2 &&
        line.left > itemLeft + bodyHeight * 0.5) {
      const item = listItems[listItems.length - 1];
      if (adjacent) item.paragraphs[item.paragraphs.length - 1].push(text);
      else item.paragraphs.push([text]);
      previous = line;
      continue;
    }
    flushList();

    // Body or callout: continue the current paragraph, or start a new one.
    // Prose running straight into a callout is a break even without a gap —
    // in the measured textbook the rule statement sat 11px under the prose,
    // inside the normal paragraph spacing. The reverse is NOT a break on its
    // own, because a callout's final line can measure at body height.
    // A callout also opens a sentence, so a tall line starting in lowercase is
    // the tail of the paragraph before it ("…at that time or" / "not."), not
    // the start of a rule statement.
    const indented = previous !== null && line.left > previous.left + bodyHeight * INDENT_RATIO;
    const entersCallout =
      line.role === 'callout' && paragraphKind !== 'callout' && !/^[a-z]/.test(text);
    const continues = paragraph.length > 0 && adjacent && !indented && !entersCallout;

    if (!continues) {
      flushParagraph();
      paragraphKind = line.role === 'callout' ? 'callout' : 'body';
    }

    paragraph.push(text);
    previous = line;
  }

  flushParagraph();
  flushList();
  flushToc();
  flushTable();
  return blocks.join('\n\n');
}

/** Left edges of the list nesting levels found in `structures`, outermost first. */
function listLevelLefts(structures: PageStructure[], bodyHeight: number): number[] {
  return clusterLefts(
    structures.flatMap(s => s.lines.filter(l => l.role === 'listItem').map(l => l.left)),
    bodyHeight * 0.5
  );
}

/**
 * Distinct left edges, ascending, with values within `tolerance` of each
 * other merged. Each cluster's position is one indent level.
 */
function clusterLefts(lefts: number[], tolerance: number): number[] {
  const clusters: number[] = [];
  for (const left of [...lefts].sort((a, b) => a - b)) {
    if (clusters.length === 0 || left - clusters[clusters.length - 1] > tolerance) {
      clusters.push(left);
    }
  }
  return clusters;
}

/**
 * Markdown heading level for a heading line.
 *
 * Size-detected lines keep the levels they always had. Subheadings take their
 * level from the outline marker, following the usual textbook hierarchy:
 * "II." above "A." above "1.".
 */
function headingPrefix(line: ClassifiedLine): string {
  if (line.role === 'title') return '#';
  if (line.role === 'heading') return '##';
  const marker = line.text.trim().split(/\s+/)[0];
  if (/^[IVXLC]{2,}\.$/.test(marker)) return '##';
  if (/^[A-Z]\.$/.test(marker)) return '###';
  if (/^[a-z]\.$/.test(marker)) return '#####';
  return '####';
}

/**
 * Render one list item as Markdown.
 *
 * Numbered markers ("1." "1)") are already Markdown list syntax. Bullet glyphs
 * become "-". Lettered markers have no Markdown equivalent, so they are kept
 * as text inside a bullet — otherwise consecutive "a. …" / "b. …" lines would
 * collapse into a single paragraph.
 *
 * Nested levels and an item's later paragraphs are indented four spaces,
 * which places them inside the item above under both "1. " and "- ".
 */
function formatListItem(item: ListItem): string {
  const indent = '    '.repeat(item.level);
  const [first, ...rest] = item.paragraphs.map(joinBodyLines);
  const bullet = first.match(/^[•●▪◦·*–-]\s+(.*)$/);
  const head = /^\d{1,2}[.)]\s/.test(first) ? first : `- ${bullet ? bullet[1] : first}`;
  return [`${indent}${head}`, ...rest.map(p => `\n${indent}    ${p}`)].join('\n');
}

/**
 * Render table rows as a Markdown table.
 *
 * The header row is left empty: nothing in the geometry says whether the
 * first row is a header or data, and promoting data to a header would
 * misstate it.
 */
function formatTable(rows: string[][]): string {
  const row = (cells: string[]) => `| ${cells.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  const columns = rows[0].length;
  return [
    row(Array(columns).fill('')),
    `|${Array(columns).fill('---').join('|')}|`,
    ...rows.map(row),
  ].join('\n');
}

/**
 * Analyse every frame and render each to Markdown.
 *
 * Returns one string per input page, aligned with `pages`, so the caller can
 * run the existing frame-level dedup over the result exactly as it does over
 * plain text. A page with no geometry yields `''`; the caller substitutes that
 * frame's plain OCR text.
 *
 * `isWord` enables dropping junk text beside the prose (see `looksLikeJunk`).
 */
export function structurePages(
  pages: OcrPageGeometry[],
  isWord?: (word: string) => boolean
): string[] {
  const metrics = documentMetrics(pages);
  if (metrics.bodyHeight <= 0) return pages.map(() => '');

  const context: StructureContext = {
    ...metrics,
    runningHeads: collectRunningHeads(pages, MARGIN_BAND),
    isWord,
  };

  const structures = pages.map(page => analysePage(page, context));
  const listLefts = listLevelLefts(structures, metrics.bodyHeight);
  return structures.map(structure => renderPageMarkdown(structure, metrics, listLefts));
}
