/**
 * Filenames suggested to a browser (PRD Phase 16 task 12).
 *
 * Two of the product's downloads name themselves after a value the product did not choose: the
 * evidence bundle after the release key, and — indirectly — anything else that follows. A release
 * key is `z.string().min(1).max(200)` at the API boundary, which is the right constraint, because a
 * release key is whatever the system that deployed it calls itself. It does mean the key can carry a
 * quote, a semicolon, a path separator, a control character or a newline.
 *
 * Interpolated straight into `content-disposition`, a quote closes the `filename` parameter and
 * everything after it becomes attacker-chosen header parameters; a path separator produces a
 * suggested name that is not a filename; and a newline is a header injection that `undici` rejects
 * by throwing, turning a download into a 500.
 *
 * The value is reduced rather than rejected. The bundle is still correct and still carries the real
 * key inside its body, so a hostile key should cost the download a tidy name — not the evidence.
 */

const SAFE_CHARACTER = /[A-Za-z0-9._-]/;
const MAX_SEGMENT = 64;

export function downloadNameSegment(value: string, fallback = "release"): string {
  const reduced = [...value]
    .map((character) => (SAFE_CHARACTER.test(character) ? character : "-"))
    .join("")
    .slice(0, MAX_SEGMENT);

  // A leading dot would produce a hidden file, and a leading dash is read as an option by enough
  // command-line tools to be worth removing from a name a human will later type.
  const trimmed = reduced.replace(/^[-.]+/, "");
  return trimmed.length === 0 ? fallback : trimmed;
}
