import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkTokens } from "./token-check.ts";
import { readHostCss, readUiSources } from "./ui-sources.ts";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("token lint", () => {
  it("finds no literal colours, px, font sizes, foreign classes or unknown tokens in the UI", () => {
    const hostCss = readHostCss(pluginRoot);
    expect(hostCss, "run inside a Paperclip checkout").not.toBeNull();
    const files = readUiSources(pluginRoot);
    expect(files.length).toBeGreaterThan(5);
    expect(checkTokens(files, hostCss)).toEqual([]);
  });

  it("flags each forbidden pattern", () => {
    const css = ":root { --border: x; --spacing: y; }";
    const file = {
      path: "x.tsx",
      content: [
        'const a = { color: "#ff0000" };',
        'const b = { color: "rgb(1, 2, 3)" };',
        'const c = { width: "12px" };',
        "const d = { fontSize: 13 };",
        '<div className="flex rm-row" />',
        'const e = { border: "var(--bordr)" };',
        'const ok = { border: "var(--border)", gap: "calc(var(--spacing) * 2)", width: "var(--sz-44px)" };',
        "@media (max-width: 767px) { .rm-x { display: none; } }",
        'const dyn = `var(--status-task-${status})`;',
      ].join("\n"),
    };
    const rules = checkTokens([file], css).map((violation) => `${violation.line}:${violation.rule}`);
    expect(rules).toEqual([
      "1:hex colour",
      "2:colour function",
      "3:raw px",
      "4:numeric font size",
      '5:class "flex" (only rm-* classes)',
      "6:unknown token --bordr",
      "7:unknown token --sz-44px",
    ]);
  });
});
