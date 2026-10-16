import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getRequiredCapability } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "test.environment-targets",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment targets",
  description: "Test environment driver plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
};

const OPERATIONS = [
  "environment.checkAvailability",
  "environments.reportTargets",
  "environments.ensureCompanyEnvironment",
] as const;

describe("environment target operations", () => {
  it.each(OPERATIONS)("%s needs only environment.drivers.register", (operation) => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities(operation)).toEqual(["environment.drivers.register"]);
    expect(validator.checkOperation(manifest, operation).allowed).toBe(true);
    expect(validator.checkOperation({ ...manifest, capabilities: ["http.outbound"] }, operation)).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
  });

  it("matches the SDK's worker→host gate", () => {
    const validator = pluginCapabilityValidator();
    for (const method of ["environments.reportTargets", "environments.ensureCompanyEnvironment"] as const) {
      expect(validator.getRequiredCapabilities(method)).toEqual([getRequiredCapability(method)]);
    }
  });
});
