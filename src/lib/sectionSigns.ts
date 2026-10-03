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
 *   1. As a standalone token directly after a code citation ("Code S 2510",
 *      "U.S.C. S 2301") — whatever follows it. On a real run the section
 *      number itself was sometimes lost ("Code S In this situation"), and
 *      the S is still a section sign there.
 *   2. Before a section number that carries a subsection ("S 2312(1)(a)").
 */

const CITATION_THEN_SIGN = /\b(Code|U\.\s?S\.\s?C\.|C\.\s?F\.\s?R\.)\s+(SS|S)\b/g;

/** "Cal. LI. Com." / "Cal. II. Com." — the U of the California Uniform Commercial Code. */
const MISREAD_CAL_U = /\bCal\.\s?(?:LI|Ll|lI|Il|II|ll)\.\s?Com\./g;

const SIGN_BEFORE_SUBSECTION = /(^|[\s[(])(SS|S)\s+(?=\d+(?:[.-]\d+)*\()/gm;

const sign = (s: string) => (s.length === 2 ? '§§' : '§');

export function restoreSectionSigns(text: string): string {
  return text
    // The citation itself is misread too: "15 U.s.c." for "15 U.S.C.".
    .replace(/\bU\.\s?s\.\s?c\./g, 'U.S.C.')
    .replace(MISREAD_CAL_U, 'Cal. U. Com.')
    .replace(CITATION_THEN_SIGN, (_, cite: string, s: string) => `${cite} ${sign(s)}`)
    .replace(SIGN_BEFORE_SUBSECTION, (_, pre: string, s: string) => `${pre}${sign(s)} `);
}
