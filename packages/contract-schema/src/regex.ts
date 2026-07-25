/**
 * An RE2-compatible regular-expression engine with no backtracking.
 *
 * PRD section 10.3 requires the `matches` operator to be RE2-compatible or to use a package with
 * denial-of-service protection, with length-limited patterns. Contract authors are trusted less
 * than the code — a contract can arrive from a pull request — and span names arrive from
 * telemetry, so both sides of a `matches` comparison are untrusted input.
 *
 * A static screen for "nested quantifiers" is not enough: `(a|a)*b` has no nested quantifier and
 * still backtracks catastrophically under a backtracking engine. And a native RE2 binding would
 * add a compiled dependency for one operator.
 *
 * So this is a Thompson NFA compiled from the pattern and simulated over a *set* of states,
 * advancing once per input character. Matching is O(pattern × input) by construction; there is no
 * backtracking to trigger. Backreferences and lookaround are absent, exactly as in RE2 — they are
 * the features that make linear-time simulation impossible.
 *
 * Semantics are RE2's `MatchString`: an unanchored search, with `^` and `$` matching the start and
 * end of the whole input. `.` excludes the newline.
 */

/** Bounds chosen so a pathological pattern is rejected at compile time, not survived at match time. */
export const REGEX_LIMITS = {
  maxPatternLength: 256,
  /** Compiled instruction ceiling. Bounded repetition expands, so the product is what matters. */
  maxProgramSize: 4_096,
  /** Highest `{m,n}` bound accepted. */
  maxRepeat: 128,
  maxClassRanges: 128,
  maxInputLength: 8_192,
} as const;

export type RegexErrorCode =
  | "PATTERN_EMPTY"
  | "PATTERN_TOO_LONG"
  | "PATTERN_UNSUPPORTED"
  | "PATTERN_SYNTAX"
  | "PATTERN_TOO_COMPLEX"
  | "PATTERN_REPEAT_TOO_LARGE";

export interface RegexError {
  readonly code: RegexErrorCode;
  readonly message: string;
  /** Zero-based offset in the pattern, where the failure is positional. */
  readonly offset?: number;
}

/** Inclusive code-point range. */
interface CodeRange {
  readonly lo: number;
  readonly hi: number;
}

/** A character class: a sorted range list, optionally negated. */
interface CharClass {
  readonly negated: boolean;
  readonly ranges: readonly CodeRange[];
}

type Node =
  | { readonly kind: "empty" }
  | { readonly kind: "class"; readonly value: CharClass }
  | { readonly kind: "concat"; readonly parts: readonly Node[] }
  | { readonly kind: "alternate"; readonly options: readonly Node[] }
  | { readonly kind: "repeat"; readonly node: Node; readonly min: number; readonly max: number }
  | { readonly kind: "bol" }
  | { readonly kind: "eol" };

/** `max: -1` means unbounded, as in `*` and `+`. */
const UNBOUNDED = -1;

type Instruction =
  | { readonly op: "class"; readonly value: CharClass }
  | { readonly op: "split"; readonly first: number; readonly second: number }
  | { readonly op: "jump"; readonly target: number }
  | { readonly op: "bol" }
  | { readonly op: "eol" }
  | { readonly op: "match" };

export interface CompiledPattern {
  readonly source: string;
  readonly program: readonly Instruction[];
  /** True when the pattern starts with `^`, so the search cannot restart at a later position. */
  readonly anchoredStart: boolean;
}

class PatternSyntaxError extends Error {
  readonly code: RegexErrorCode;
  readonly offset: number | undefined;

  constructor(code: RegexErrorCode, message: string, offset?: number) {
    super(message);
    this.name = "PatternSyntaxError";
    this.code = code;
    this.offset = offset;
  }
}

const CODE_NEWLINE = 0x0a;

function singleton(code: number): CharClass {
  return { negated: false, ranges: [{ lo: code, hi: code }] };
}

/** Sorts and merges ranges so two spellings of one class compile identically. */
function normaliseRanges(ranges: readonly CodeRange[]): readonly CodeRange[] {
  const sorted = [...ranges].sort((a, b) => (a.lo !== b.lo ? a.lo - b.lo : a.hi - b.hi));
  const merged: CodeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.lo <= last.hi + 1) {
      if (range.hi > last.hi) merged[merged.length - 1] = { lo: last.lo, hi: range.hi };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

const DIGIT_RANGES: readonly CodeRange[] = [{ lo: 0x30, hi: 0x39 }];
const WORD_RANGES: readonly CodeRange[] = [
  { lo: 0x30, hi: 0x39 },
  { lo: 0x41, hi: 0x5a },
  { lo: 0x5f, hi: 0x5f },
  { lo: 0x61, hi: 0x7a },
];
const SPACE_RANGES: readonly CodeRange[] = [
  { lo: 0x09, hi: 0x0d },
  { lo: 0x20, hi: 0x20 },
];

/** Escapes accepted both inside and outside a character class. */
const LITERAL_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["\\", 0x5c],
  ["/", 0x2f],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["f", 0x0c],
  ["v", 0x0b],
  ["0", 0x00],
  [".", 0x2e],
  ["*", 0x2a],
  ["+", 0x2b],
  ["?", 0x3f],
  ["(", 0x28],
  [")", 0x29],
  ["[", 0x5b],
  ["]", 0x5d],
  ["{", 0x7b],
  ["}", 0x7d],
  ["|", 0x7c],
  ["^", 0x5e],
  ["$", 0x24],
  ["-", 0x2d],
]);

const CLASS_SHORTHANDS: ReadonlyMap<string, CharClass> = new Map([
  ["d", { negated: false, ranges: DIGIT_RANGES }],
  ["D", { negated: true, ranges: DIGIT_RANGES }],
  ["w", { negated: false, ranges: WORD_RANGES }],
  ["W", { negated: true, ranges: WORD_RANGES }],
  ["s", { negated: false, ranges: SPACE_RANGES }],
  ["S", { negated: true, ranges: SPACE_RANGES }],
]);

/**
 * Recursive-descent parser over code points.
 *
 * Recursion depth is bounded by the pattern length, which is itself bounded to 256, so the parser
 * cannot overflow the stack on any pattern it will accept.
 */
class Parser {
  readonly #codes: readonly number[];
  #position = 0;

  constructor(source: string) {
    this.#codes = [...source].map((character) => character.codePointAt(0) ?? 0);
  }

  parse(): Node {
    const node = this.#parseAlternate();
    if (this.#position < this.#codes.length) {
      throw new PatternSyntaxError(
        "PATTERN_SYNTAX",
        `Unexpected ${this.#describeHere()} in pattern.`,
        this.#position,
      );
    }
    return node;
  }

  #describeHere(): string {
    const code = this.#codes[this.#position];
    return code === undefined ? "end of pattern" : `character "${String.fromCodePoint(code)}"`;
  }

  #peek(): number | undefined {
    return this.#codes[this.#position];
  }

  #take(): number {
    const code = this.#codes[this.#position];
    if (code === undefined) {
      throw new PatternSyntaxError("PATTERN_SYNTAX", "Pattern ended unexpectedly.", this.#position);
    }
    this.#position += 1;
    return code;
  }

  #eat(code: number): boolean {
    if (this.#codes[this.#position] !== code) return false;
    this.#position += 1;
    return true;
  }

  #parseAlternate(): Node {
    const options: Node[] = [this.#parseConcat()];
    while (this.#eat(0x7c /* | */)) options.push(this.#parseConcat());
    return options.length === 1 ? (options[0] as Node) : { kind: "alternate", options };
  }

  #parseConcat(): Node {
    const parts: Node[] = [];
    for (;;) {
      const code = this.#peek();
      if (code === undefined || code === 0x7c /* | */ || code === 0x29 /* ) */) break;
      parts.push(this.#parseRepeat());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? (parts[0] as Node) : { kind: "concat", parts };
  }

  #parseRepeat(): Node {
    const atom = this.#parseAtom();
    let node = atom;

    for (;;) {
      const code = this.#peek();
      if (code === 0x2a /* * */) {
        this.#position += 1;
        node = { kind: "repeat", node, min: 0, max: UNBOUNDED };
      } else if (code === 0x2b /* + */) {
        this.#position += 1;
        node = { kind: "repeat", node, min: 1, max: UNBOUNDED };
      } else if (code === 0x3f /* ? */) {
        this.#position += 1;
        node = { kind: "repeat", node, min: 0, max: 1 };
      } else if (code === 0x7b /* { */) {
        const bounds = this.#tryParseBounds();
        if (bounds === undefined) break;
        node = { kind: "repeat", node, min: bounds.min, max: bounds.max };
      } else {
        break;
      }

      // RE2 rejects a repeat applied to a repeat (`a**`); so do we, rather than guessing.
      const next = this.#peek();
      if (next === 0x2a || next === 0x2b || next === 0x3f) {
        throw new PatternSyntaxError(
          "PATTERN_UNSUPPORTED",
          "A repetition may not be applied to another repetition. Wrap it in a group.",
          this.#position,
        );
      }
    }

    return node;
  }

  /** `{m}`, `{m,}` or `{m,n}`. A `{` that is not a valid bound is a literal brace, as in RE2. */
  #tryParseBounds(): { readonly min: number; readonly max: number } | undefined {
    const start = this.#position;
    this.#position += 1;

    const min = this.#parseInteger();
    if (min === undefined) {
      this.#position = start;
      return undefined;
    }

    let max = min;
    if (this.#eat(0x2c /* , */)) {
      const upper = this.#parseInteger();
      max = upper === undefined ? UNBOUNDED : upper;
    }

    if (!this.#eat(0x7d /* } */)) {
      this.#position = start;
      return undefined;
    }

    if (min > REGEX_LIMITS.maxRepeat || (max !== UNBOUNDED && max > REGEX_LIMITS.maxRepeat)) {
      throw new PatternSyntaxError(
        "PATTERN_REPEAT_TOO_LARGE",
        `A repetition bound may not exceed ${REGEX_LIMITS.maxRepeat}.`,
        start,
      );
    }
    if (max !== UNBOUNDED && max < min) {
      throw new PatternSyntaxError(
        "PATTERN_SYNTAX",
        "A repetition's upper bound is below its lower bound.",
        start,
      );
    }

    return { min, max };
  }

  #parseInteger(): number | undefined {
    let digits = "";
    for (;;) {
      const code = this.#peek();
      if (code === undefined || code < 0x30 || code > 0x39) break;
      digits += String.fromCodePoint(code);
      this.#position += 1;
      // A bound longer than the limit's digit count cannot be in range, and refusing to accumulate
      // it keeps the parse bounded regardless of pattern content.
      if (digits.length > 4) {
        throw new PatternSyntaxError(
          "PATTERN_REPEAT_TOO_LARGE",
          `A repetition bound may not exceed ${REGEX_LIMITS.maxRepeat}.`,
          this.#position,
        );
      }
    }
    return digits.length === 0 ? undefined : Number.parseInt(digits, 10);
  }

  #parseAtom(): Node {
    const code = this.#take();

    switch (code) {
      case 0x28 /* ( */:
        {
          // `(?...)` covers capture-group flags, lookahead and named groups. RE2 supports some of
          // these; none is needed to select a span, and accepting a syntax we do not implement would
          // silently change what a contract means.
          if (this.#peek() === 0x3f /* ? */) {
            throw new PatternSyntaxError(
              "PATTERN_UNSUPPORTED",
              "Group flags, lookaround and named groups are not supported.",
              this.#position - 1,
            );
          }
          const inner = this.#parseAlternate();
          if (!this.#eat(0x29 /* ) */)) {
            throw new PatternSyntaxError(
              "PATTERN_SYNTAX",
              "Unclosed group in pattern.",
              this.#position,
            );
          }
          return inner;
        }
      case 0x29 /* ) */:
        throw new PatternSyntaxError(
          "PATTERN_SYNTAX",
          "Unmatched closing parenthesis.",
          this.#position - 1,
        );
      case 0x5b /* [ */:
        return { kind: "class", value: this.#parseCharClass() };
      case 0x5d /* ] */:
        return { kind: "class", value: singleton(code) };
      case 0x2e /* . */:
        return {
          kind: "class",
          value: { negated: true, ranges: [{ lo: CODE_NEWLINE, hi: CODE_NEWLINE }] },
        };
      case 0x5e /* ^ */:
        return { kind: "bol" };
      case 0x24 /* $ */:
        return { kind: "eol" };
      case 0x2a /* * */:
      case 0x2b /* + */:
      case 0x3f /* ? */:
        throw new PatternSyntaxError(
          "PATTERN_SYNTAX",
          "A repetition has nothing to repeat.",
          this.#position - 1,
        );
      case 0x5c /* \ */:
        return this.#parseEscape();
      default:
        return { kind: "class", value: singleton(code) };
    }
  }

  #parseEscape(): Node {
    const code = this.#take();
    const character = String.fromCodePoint(code);

    const shorthand = CLASS_SHORTHANDS.get(character);
    if (shorthand !== undefined) return { kind: "class", value: shorthand };

    const literal = LITERAL_ESCAPES.get(character);
    if (literal !== undefined) return { kind: "class", value: singleton(literal) };

    // `\b`, `\B`, `\A`, `\z` are zero-width assertions; `\1` is a backreference; `\p{...}` is a
    // Unicode class. Each is either unimplementable in linear time or unnecessary here.
    throw new PatternSyntaxError(
      "PATTERN_UNSUPPORTED",
      `The escape "\\${character}" is not supported. Use a literal, a class, or \\d \\w \\s.`,
      this.#position - 1,
    );
  }

  #parseCharClass(): CharClass {
    const negated = this.#eat(0x5e /* ^ */);
    const ranges: CodeRange[] = [];
    let first = true;

    for (;;) {
      const code = this.#peek();
      if (code === undefined) {
        throw new PatternSyntaxError("PATTERN_SYNTAX", "Unclosed character class.", this.#position);
      }
      // `]` is a literal only as the very first member, matching RE2 and POSIX.
      if (code === 0x5d /* ] */ && !first) {
        this.#position += 1;
        break;
      }
      first = false;

      if (ranges.length >= REGEX_LIMITS.maxClassRanges) {
        throw new PatternSyntaxError(
          "PATTERN_TOO_COMPLEX",
          `A character class may not hold more than ${REGEX_LIMITS.maxClassRanges} members.`,
          this.#position,
        );
      }

      const member = this.#parseClassMember();
      if (member.kind === "class") {
        // A shorthand inside a class contributes its ranges. A negated shorthand cannot be merged
        // into a range list without complementing it, which changes meaning inside a negated
        // class, so it is refused rather than approximated.
        if (member.value.negated) {
          throw new PatternSyntaxError(
            "PATTERN_UNSUPPORTED",
            "A negated shorthand such as \\D may not appear inside a character class.",
            this.#position - 1,
          );
        }
        ranges.push(...member.value.ranges);
        continue;
      }

      // A `-` between two members is a range; a trailing or leading `-` is a literal.
      if (this.#peek() === 0x2d /* - */ && this.#codes[this.#position + 1] !== 0x5d) {
        this.#position += 1;
        const upper = this.#parseClassMember();
        if (upper.kind !== "code") {
          throw new PatternSyntaxError(
            "PATTERN_SYNTAX",
            "A character range may not use a shorthand class as a bound.",
            this.#position - 1,
          );
        }
        if (upper.code < member.code) {
          throw new PatternSyntaxError(
            "PATTERN_SYNTAX",
            "A character range is inverted.",
            this.#position - 1,
          );
        }
        ranges.push({ lo: member.code, hi: upper.code });
        continue;
      }

      ranges.push({ lo: member.code, hi: member.code });
    }

    if (ranges.length === 0) {
      throw new PatternSyntaxError("PATTERN_SYNTAX", "An empty character class matches nothing.");
    }

    return { negated, ranges: normaliseRanges(ranges) };
  }

  #parseClassMember():
    | { readonly kind: "code"; readonly code: number }
    | { readonly kind: "class"; readonly value: CharClass } {
    const code = this.#take();
    if (code !== 0x5c /* \ */) return { kind: "code", code };

    const escaped = this.#take();
    const character = String.fromCodePoint(escaped);

    const shorthand = CLASS_SHORTHANDS.get(character);
    if (shorthand !== undefined) return { kind: "class", value: shorthand };

    const literal = LITERAL_ESCAPES.get(character);
    if (literal !== undefined) return { kind: "code", code: literal };

    throw new PatternSyntaxError(
      "PATTERN_UNSUPPORTED",
      `The escape "\\${character}" is not supported inside a character class.`,
      this.#position - 1,
    );
  }
}

/**
 * Thompson construction.
 *
 * Emits instructions into a flat array. `{m,n}` is expanded by re-emitting the sub-pattern, which
 * is why the program size is capped: `(ab){128}` is legitimate, and an unbounded expansion budget
 * would let a 200-character pattern compile to millions of instructions.
 */
class Compiler {
  readonly #program: Instruction[] = [];

  compile(node: Node): readonly Instruction[] {
    this.#emitNode(node);
    this.#push({ op: "match" });
    return this.#program;
  }

  #push(instruction: Instruction): number {
    if (this.#program.length >= REGEX_LIMITS.maxProgramSize) {
      throw new PatternSyntaxError(
        "PATTERN_TOO_COMPLEX",
        `The pattern compiles to more than ${REGEX_LIMITS.maxProgramSize} instructions.`,
      );
    }
    this.#program.push(instruction);
    return this.#program.length - 1;
  }

  #patch(index: number, instruction: Instruction): void {
    this.#program[index] = instruction;
  }

  get #next(): number {
    return this.#program.length;
  }

  #emitNode(node: Node): void {
    switch (node.kind) {
      case "empty":
        return;
      case "class":
        this.#push({ op: "class", value: node.value });
        return;
      case "bol":
        this.#push({ op: "bol" });
        return;
      case "eol":
        this.#push({ op: "eol" });
        return;
      case "concat":
        for (const part of node.parts) this.#emitNode(part);
        return;
      case "alternate":
        this.#emitAlternate(node.options);
        return;
      case "repeat":
        this.#emitRepeat(node.node, node.min, node.max);
        return;
    }
  }

  #emitAlternate(options: readonly Node[]): void {
    if (options.length === 1) {
      this.#emitNode(options[0] as Node);
      return;
    }

    const jumpsToEnd: number[] = [];
    for (let index = 0; index < options.length - 1; index += 1) {
      const split = this.#push({ op: "split", first: 0, second: 0 });
      this.#patch(split, { op: "split", first: this.#next, second: 0 });
      this.#emitNode(options[index] as Node);
      jumpsToEnd.push(this.#push({ op: "jump", target: 0 }));
      const secondTarget = this.#next;
      const patched = this.#program[split] as { op: "split"; first: number; second: number };
      this.#patch(split, { op: "split", first: patched.first, second: secondTarget });
    }
    this.#emitNode(options[options.length - 1] as Node);

    const end = this.#next;
    for (const jump of jumpsToEnd) this.#patch(jump, { op: "jump", target: end });
  }

  #emitRepeat(node: Node, min: number, max: number): void {
    for (let index = 0; index < min; index += 1) this.#emitNode(node);

    if (max === UNBOUNDED) {
      // `x*` over the tail: split into the body or past it, and loop back after the body.
      const split = this.#push({ op: "split", first: 0, second: 0 });
      const bodyStart = this.#next;
      this.#emitNode(node);
      // An empty body would loop forever; `()*` is accepted and treated as matching nothing.
      if (this.#next === bodyStart) {
        this.#patch(split, { op: "jump", target: this.#next });
        return;
      }
      this.#push({ op: "jump", target: split });
      this.#patch(split, { op: "split", first: bodyStart, second: this.#next });
      return;
    }

    const optionalCount = max - min;
    const splits: number[] = [];
    for (let index = 0; index < optionalCount; index += 1) {
      const split = this.#push({ op: "split", first: 0, second: 0 });
      splits.push(split);
      this.#patch(split, { op: "split", first: this.#next, second: 0 });
      this.#emitNode(node);
    }
    const end = this.#next;
    for (const split of splits) {
      const patched = this.#program[split] as { op: "split"; first: number; second: number };
      this.#patch(split, { op: "split", first: patched.first, second: end });
    }
  }
}

export type CompileResult =
  | { readonly ok: true; readonly pattern: CompiledPattern }
  | { readonly ok: false; readonly error: RegexError };

export function compilePattern(source: string): CompileResult {
  if (source.length === 0) {
    return { ok: false, error: { code: "PATTERN_EMPTY", message: "The pattern is empty." } };
  }
  if (source.length > REGEX_LIMITS.maxPatternLength) {
    return {
      ok: false,
      error: {
        code: "PATTERN_TOO_LONG",
        message: `A pattern may not exceed ${REGEX_LIMITS.maxPatternLength} characters.`,
      },
    };
  }

  try {
    const ast = new Parser(source).parse();
    const program = new Compiler().compile(ast);
    return {
      ok: true,
      pattern: { source, program, anchoredStart: startsAnchored(ast) },
    };
  } catch (error: unknown) {
    if (error instanceof PatternSyntaxError) {
      return {
        ok: false,
        error:
          error.offset === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, message: error.message, offset: error.offset },
      };
    }
    throw error;
  }
}

/**
 * True when every alternative begins with `^`.
 *
 * Only then can the simulation skip restarting the search at later positions. Getting this wrong
 * in the conservative direction costs a little work; getting it wrong the other way would change
 * which strings match.
 */
function startsAnchored(node: Node): boolean {
  switch (node.kind) {
    case "bol":
      return true;
    case "concat":
      return node.parts.length > 0 && startsAnchored(node.parts[0] as Node);
    case "alternate":
      return node.options.every(startsAnchored);
    default:
      return false;
  }
}

function classMatches(value: CharClass, code: number): boolean {
  let inside = false;
  for (const range of value.ranges) {
    if (code >= range.lo && code <= range.hi) {
      inside = true;
      break;
    }
  }
  return value.negated ? !inside : inside;
}

/**
 * Simulates the NFA over the input.
 *
 * Two state lists are kept, current and next, each with a generation marker so a state is added at
 * most once per input position. That bound is what makes the run linear: the work per character is
 * proportional to the program size, never to the number of possible paths.
 */
export function matchPattern(pattern: CompiledPattern, input: string): boolean {
  if (input.length > REGEX_LIMITS.maxInputLength) return false;

  const codes = [...input].map((character) => character.codePointAt(0) ?? 0);
  const size = pattern.program.length;
  const marks = new Int32Array(size).fill(-1);
  let current: number[] = [];
  let next: number[] = [];
  let generation = 0;

  const add = (list: number[], start: number, position: number): void => {
    // Iterative epsilon closure. A recursive closure would overflow on a pattern such as `a{128}?`
    // whose split chain is as long as the program.
    const pending = [start];
    while (pending.length > 0) {
      const index = pending.pop() as number;
      if (index >= size || marks[index] === generation) continue;
      marks[index] = generation;

      const instruction = pattern.program[index] as Instruction;
      switch (instruction.op) {
        case "split":
          pending.push(instruction.second, instruction.first);
          break;
        case "jump":
          pending.push(instruction.target);
          break;
        case "bol":
          if (position === 0) pending.push(index + 1);
          break;
        case "eol":
          if (position === codes.length) pending.push(index + 1);
          break;
        default:
          list.push(index);
          break;
      }
    }
  };

  generation += 1;
  add(current, 0, 0);

  for (let position = 0; ; position += 1) {
    for (const index of current) {
      if ((pattern.program[index] as Instruction).op === "match") return true;
    }
    if (position >= codes.length) break;

    const code = codes[position] as number;
    next = [];
    generation += 1;

    for (const index of current) {
      const instruction = pattern.program[index] as Instruction;
      if (instruction.op === "class" && classMatches(instruction.value, code)) {
        add(next, index + 1, position + 1);
      }
    }

    // Unanchored search: the match may begin at any later position.
    if (!pattern.anchoredStart) add(next, 0, position + 1);

    current = next;
    if (current.length === 0 && pattern.anchoredStart) return false;
  }

  return false;
}
