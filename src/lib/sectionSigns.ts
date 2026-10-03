/**
 * Restores section signs that Windows OCR reads as the letter "S".
 *
 * The English recogniser has no "§" in its alphabet, so it substitutes the
 * nearest shape. Measured on three pages of a law textbook: every one of ~20
 * section signs came back as "S" ("Cal. U. Com. Code S 2510(2)"), and "§§"
 * reads as "SS" by the same mechanism.
 *
 * Only the two contexts where an "S" is unambiguously a section sign are
 * rewritten, so ordinary capital S elsewhere is left alone:
 *   1. Directly after a code citation ("Code S 2510", "U.S.C. S 2301"),
 *      including at a line end where the number wrapped to the next line.
 *   2. Before a section number that carries a subsection ("S 2312(1)(a)").
 */

const CITATION_THEN_SIGN =
  /\b(Code|U\.\s?S\.\s?C\.|C\.\s?F\.\s?R\.)\s+(SS|S)(?=\s+\d|[ \t]*$)/gm;

const SIGN_BEFORE_SUBSECTION = /(^|[\s[(])(SS|S)\s+(?=\d+(?:[.-]\d+)*\()/gm;

const sign = (s: string) => (s.length === 2 ? '§§' : '§');

export function restoreSectionSigns(text: string): string {
  return text
    // The citation itself is misread too: "15 U.s.c." for "15 U.S.C.".
    .replace(/\bU\.\s?s\.\s?c\./g, 'U.S.C.')
    .replace(CITATION_THEN_SIGN, (_, cite: string, s: string) => `${cite} ${sign(s)}`)
    .replace(SIGN_BEFORE_SUBSECTION, (_, pre: string, s: string) => `${pre}${sign(s)} `);
}
