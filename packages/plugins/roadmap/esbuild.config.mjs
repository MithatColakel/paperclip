import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  workerEntry: "src/worker.ts",
  manifestEntry: "src/manifest.ts",
  uiEntry: "src/ui/index.tsx",
});
const watch = process.argv.includes("--watch");

const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(presets.esbuild.ui),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("esbuild watching worker, manifest and ui");
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
