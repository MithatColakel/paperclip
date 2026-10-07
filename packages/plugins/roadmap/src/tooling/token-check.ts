/**
 * Token lint for the plugin UI (plan §10.8). Host Tailwind does not compile
 * plugin sources, so plugin UI must style itself with host tokens only:
 *   - no hex, rgb(), hsl(), oklch() or oklab() colour literals;
 *   - no raw px lengths (media queries excepted: CSS variables cannot be used there);
 *   - no numeric fontSize / font-size;
 *   - no Tailwind or other non-`rm-` class names;
 *   - every `var(--name)` must exist in the host CSS.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export interface TokenViolation {
  path: string;
  line: number;
  rule: string;
  text: string;
}

/**
 * Theme variables Tailwind emits into the compiled host CSS although
 * ui/src/index.css does not declare them (checked against a compiled host
 * stylesheet built from ui/src/index.css on 2026-10-07).
 */
export const TAILWIND_THEME_VARIABLES: ReadonlySet<string> = new Set([
  "--spacing",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--leading-tight",
  "--leading-snug",
  "--leading-normal",
]);

export function declaredVariables(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

const RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "hex colour", pattern: /(?<![\w&/-])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?(?![\w-])/ },
  { rule: "colour function", pattern: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/ },
  { rule: "raw px", pattern: /(?<![\w-])\d+(?:\.\d+)?px\b/ },
  { rule: "numeric font size", pattern: /(?:fontSize\s*:\s*["'`]?\d|font-size\s*:\s*\d)/ },
];

const EXEMPT_LINE = /@media|matchMedia|MOBILE_QUERY\s*=/;

function classNameViolations(line: string): string[] {
  const bad: string[] = [];
  for (const match of line.matchAll(/className=(?:\{\s*)?["'`]([^"'`]*)["'`]/g)) {
    const value = match[1] ?? "";
    if (value.includes("${")) continue;
    for (const name of value.split(/\s+/).filter(Boolean)) {
      if (!name.startsWith("rm-")) bad.push(name);
    }
  }
  // Ternaries such as className={live ? "rm-dot rm-live" : "rm-dot"}.
  for (const match of line.matchAll(/className=\{[^}]*\}/g)) {
    for (const literal of match[0].matchAll(/["'`]([^"'`]*)["'`]/g)) {
      for (const name of (literal[1] ?? "").split(/\s+/).filter(Boolean)) {
        if (!name.startsWith("rm-") && !bad.includes(name)) bad.push(name);
      }
    }
  }
  return bad;
}

export function checkTokens(files: readonly SourceFile[], hostCss: string | null): TokenViolation[] {
  const known = hostCss === null ? null : declaredVariables(hostCss);
  const violations: TokenViolation[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((text, index) => {
      const line = index + 1;
      const trimmed = text.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (!EXEMPT_LINE.test(text)) {
        for (const { rule, pattern } of RULES) {
          if (pattern.test(text)) violations.push({ path: file.path, line, rule, text: trimmed });
        }
      }
      for (const name of classNameViolations(text)) {
        violations.push({ path: file.path, line, rule: `class "${name}" (only rm-* classes)`, text: trimmed });
      }
      if (known) {
        for (const match of text.matchAll(/var\((--[A-Za-z0-9_-]+)(\$\{)?/g)) {
          const name = match[1];
          if (!name || match[2]) continue; // dynamic names such as --status-task-${status}
          if (!known.has(name) && !TAILWIND_THEME_VARIABLES.has(name)) {
            violations.push({ path: file.path, line, rule: `unknown token ${name}`, text: trimmed });
          }
        }
      }
    });
  }
  return violations;
}
