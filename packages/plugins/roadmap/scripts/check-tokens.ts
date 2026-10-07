// Token lint for the Roadmap UI: `pnpm --filter @paperclipai/plugin-roadmap check:tokens`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTokens } from "../src/tooling/token-check.ts";
import { readHostCss, readUiSources } from "../src/tooling/ui-sources.ts";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostCss = readHostCss(pluginRoot);
if (hostCss === null) console.warn("Host CSS not found (plugin outside a Paperclip checkout): token names are not checked.");
const files = readUiSources(pluginRoot);
const violations = checkTokens(files, hostCss);
for (const violation of violations) {
  console.error(`${violation.path}:${violation.line}  ${violation.rule}\n    ${violation.text}`);
}
console.log(`check-tokens: ${files.length} files, ${violations.length} violations`);
process.exit(violations.length > 0 ? 1 : 0);
