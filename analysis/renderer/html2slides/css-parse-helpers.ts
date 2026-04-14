/**
 * Browser-compatible CSS parsing helpers.
 *
 * These replace regex-based parsing in extract-dom.ts with proper
 * recursive-descent parsers for CSS gradient, box-shadow, and color values.
 *
 * NO runtime dependencies — designed to run inside Chrome via CDP evaluate.
 * The parsing approach is inspired by postcss-value-parser's tokenizer
 * but implemented standalone.
 */

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { type: "word"; value: string }
  | { type: "function"; name: string; args: Token[] }
  | { type: "comma" }
  | { type: "space" };

/**
 * Tokenize a CSS value string into structured tokens.
 * Handles nested parentheses (e.g. rgba() inside linear-gradient()).
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  function skipWhitespace(): void {
    let found = false;
    while (i < len && /\s/.test(input[i])) {
      i++;
      found = true;
    }
    if (found && tokens.length > 0) {
      tokens.push({ type: "space" });
    }
  }

  function readWord(): string {
    const start = i;
    while (i < len && !/[\s,()]/.test(input[i])) {
      i++;
    }
    return input.substring(start, i);
  }

  function readFunction(name: string): Token {
    // i is right after '('
    const args: Token[] = [];
    while (i < len && input[i] !== ")") {
      skipWhitespace();
      if (i < len && input[i] === ",") {
        args.push({ type: "comma" });
        i++;
        continue;
      }
      if (i < len && input[i] === ")") break;

      const word = readWord();
      if (word.length > 0) {
        if (i < len && input[i] === "(") {
          i++; // skip '('
          args.push(readFunction(word));
        } else {
          args.push({ type: "word", value: word });
        }
      }
    }
    if (i < len && input[i] === ")") i++; // skip ')'
    return { type: "function", name, args };
  }

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;

    if (input[i] === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }

    const word = readWord();
    if (word.length > 0) {
      if (i < len && input[i] === "(") {
        i++; // skip '('
        tokens.push(readFunction(word));
      } else {
        tokens.push({ type: "word", value: word });
      }
    }
  }

  return tokens;
}

// ─── Color parsing ──────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function toHex2(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
}

/** Convert an rgb/rgba function token to hex. */
function colorFuncToHex(tok: Token): string | null {
  if (tok.type !== "function") return null;
  const name = tok.name.toLowerCase();
  if (name !== "rgb" && name !== "rgba") return null;

  const nums = tok.args
    .filter((a): a is { type: "word"; value: string } => a.type === "word")
    .map(a => parseFloat(a.value))
    .filter(n => !isNaN(n));

  if (nums.length < 3) return null;
  return "#" + toHex2(nums[0]) + toHex2(nums[1]) + toHex2(nums[2]);
}

/** Parse a hex color string, normalizing 3-char to 6-char form. */
function normalizeHex(s: string): string | null {
  if (!s.startsWith("#")) return null;
  const hex = s.slice(1);
  if (hex.length === 3) {
    return "#" + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length === 6 || hex.length === 8) {
    return "#" + hex.slice(0, 6);
  }
  return null;
}

/**
 * Parse any CSS color value to a 6-digit hex string.
 * Supports: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba().
 * Returns null for unrecognized formats (named colors, hsl, etc.).
 */
export function parseColor(color: string): string | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (trimmed === "transparent" || trimmed === "rgba(0, 0, 0, 0)") return null;

  // Hex
  if (trimmed.startsWith("#")) return normalizeHex(trimmed);

  // rgb()/rgba()
  const tokens = tokenize(trimmed);
  for (const tok of tokens) {
    if (tok.type === "function") {
      const hex = colorFuncToHex(tok);
      if (hex) return hex;
    }
  }
  return null;
}

// ─── Gradient parsing ───────────────────────────────────────────────────────

const DIRECTION_ANGLES: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
  "to top right": 45,
  "to right top": 45,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom left": 225,
  "to left bottom": 225,
  "to top left": 315,
  "to left top": 315,
};

/**
 * Parse a CSS linear-gradient() value into angle and color stops.
 *
 * Supports:
 *   linear-gradient(135deg, rgb(30,136,229), rgb(142,36,170))
 *   linear-gradient(to right, #ff0000 0%, #0000ff 100%)
 *   linear-gradient(#aaa, #bbb)  (no angle → default 180deg)
 *
 * Returns null for radial-gradient, conic-gradient, or unparseable values.
 */
export function parseLinearGradient(
  bgImage: string
): { angle: number; stops: { color: string; position: number }[] } | null {
  if (!bgImage || !bgImage.includes("linear-gradient")) return null;

  const tokens = tokenize(bgImage);

  // Find the linear-gradient function token
  let gradFunc: Token | null = null;
  for (const tok of tokens) {
    if (tok.type === "function" && tok.name === "linear-gradient") {
      gradFunc = tok;
      break;
    }
  }
  if (!gradFunc || gradFunc.type !== "function") return null;

  // Split args by commas into groups
  const groups: Token[][] = [];
  let current: Token[] = [];
  for (const arg of gradFunc.args) {
    if (arg.type === "comma") {
      if (current.length > 0) groups.push(current);
      current = [];
    } else if (arg.type !== "space") {
      current.push(arg);
    }
  }
  if (current.length > 0) groups.push(current);

  if (groups.length < 2) return null;

  // Parse angle from first group (if present)
  let angle = 180; // default: to bottom
  let colorStartIdx = 0;

  const firstGroup = groups[0];
  const firstWord = firstGroup[0];

  if (firstWord.type === "word") {
    const val = firstWord.value;

    // Check for "Ndeg"
    const degMatch = val.match(/^(-?\d+(?:\.\d+)?)deg$/);
    if (degMatch) {
      angle = parseFloat(degMatch[1]);
      colorStartIdx = 1;
    }
    // Check for directional keywords like "to", "right", etc.
    else if (val === "to") {
      const dirWords = firstGroup
        .filter((t): t is { type: "word"; value: string } => t.type === "word")
        .map(t => t.value)
        .join(" ");
      if (dirWords in DIRECTION_ANGLES) {
        angle = DIRECTION_ANGLES[dirWords];
        colorStartIdx = 1;
      }
    }
  }

  // Parse color stops
  const stops: { color: string; position: number }[] = [];
  const colorGroups = groups.slice(colorStartIdx);

  for (let gi = 0; gi < colorGroups.length; gi++) {
    const group = colorGroups[gi];
    let color: string | null = null;
    let position: number | undefined = undefined;

    for (const tok of group) {
      if (tok.type === "function") {
        const hex = colorFuncToHex(tok);
        if (hex) color = hex;
      } else if (tok.type === "word") {
        // Could be a hex color or a percentage
        if (tok.value.startsWith("#")) {
          color = normalizeHex(tok.value);
        } else if (tok.value.endsWith("%")) {
          position = parseFloat(tok.value) / 100;
        }
      }
    }

    if (color) {
      // Default positions: first stop = 0, last stop = 1, middle = evenly spaced
      if (position === undefined) {
        if (gi === 0) position = 0;
        else if (gi === colorGroups.length - 1) position = 1;
        else position = gi / (colorGroups.length - 1);
      }
      stops.push({ color, position });
    }
  }

  if (stops.length < 2) return null;
  return { angle, stops };
}

// ─── Box-shadow parsing ─────────────────────────────────────────────────────

/**
 * Parse a CSS box-shadow value into its components.
 *
 * Handles both orderings:
 *   "0px 4px 8px rgba(0,0,0,0.2)"
 *   "rgba(60,64,67,0.3) 0px 1px 3px 0px"
 *
 * For multiple shadows (comma-separated), returns only the first.
 * Returns null for "none" or unparseable values.
 */
export function parseBoxShadow(
  shadow: string
): {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string | null;
} | null {
  if (!shadow || shadow.trim() === "none") return null;

  const tokens = tokenize(shadow);

  // Split by commas to isolate the first shadow
  const firstShadowTokens: Token[] = [];
  for (const tok of tokens) {
    if (tok.type === "comma") break;
    firstShadowTokens.push(tok);
  }

  // Extract numeric px values and color
  const pxValues: number[] = [];
  let color: string | null = null;

  for (const tok of firstShadowTokens) {
    if (tok.type === "word") {
      const pxMatch = tok.value.match(/^(-?\d+(?:\.\d+)?)px$/);
      if (pxMatch) {
        pxValues.push(parseFloat(pxMatch[1]));
      } else if (tok.value.startsWith("#")) {
        color = normalizeHex(tok.value);
      }
    } else if (tok.type === "function") {
      const hex = colorFuncToHex(tok);
      if (hex) color = hex;
    }
  }

  if (pxValues.length < 2) return null;

  return {
    offsetX: pxValues[0],
    offsetY: pxValues[1],
    blur: pxValues[2] ?? 0,
    spread: pxValues[3] ?? 0,
    color,
  };
}
