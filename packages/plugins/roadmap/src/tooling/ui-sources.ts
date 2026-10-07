import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SourceFile } from "./token-check.ts";

/** UI sources of this plugin, and the host CSS when the plugin sits in a Paperclip checkout. */
export function readUiSources(pluginRoot: string): SourceFile[] {
  const dir = path.join(pluginRoot, "src", "ui");
  return readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({ path: `src/ui/${name}`, content: readFileSync(path.join(dir, name), "utf8") }));
}

export function readHostCss(pluginRoot: string): string | null {
  const uiSrc = path.resolve(pluginRoot, "..", "..", "..", "ui", "src");
  const files = ["index.css", "motion-tokens.css"].map((name) => path.join(uiSrc, name));
  if (!files.every((file) => existsSync(file))) return null;
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}
