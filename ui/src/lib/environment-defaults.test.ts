import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import {
  hasRemoteEnvironmentChoice,
  inheritedEnvironmentLabel,
  resolveInheritedEnvironment,
  selectableEnvironments,
} from "./environment-defaults";

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env",
    companyId: null,
    name: "Env",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const local = makeEnvironment({ id: "local", name: "Local", metadata: { defaultForInstance: true } });
const device = makeEnvironment({ id: "device", name: "Build computer", driver: "sandbox", config: { provider: "box" } });
const ssh = makeEnvironment({ id: "ssh", name: "Runner", driver: "ssh" });
const archived = makeEnvironment({ id: "old", name: "Old", driver: "ssh", status: "archived" });
const fake = makeEnvironment({ id: "fake", name: "Fake", driver: "sandbox", config: { provider: "fake" } });

describe("environment pickers", () => {
  it("offers active, runnable environments only", () => {
    expect(selectableEnvironments([local, device, ssh, archived, fake]).map((env) => env.id)).toEqual([
      "local",
      "device",
      "ssh",
    ]);
    // A local-only adapter cannot run on remote machines.
    expect(selectableEnvironments([local, device, ssh], "http").map((env) => env.id)).toEqual(["local"]);
  });

  it("only asks when somewhere other than the local host exists", () => {
    expect(hasRemoteEnvironmentChoice([local])).toBe(false);
    expect(hasRemoteEnvironmentChoice([local, archived, fake])).toBe(false);
    expect(hasRemoteEnvironmentChoice([local, device])).toBe(true);
  });
});

describe("resolveInheritedEnvironment", () => {
  const environments = [local, device, ssh];

  it("walks project, company, instance, then the local host", () => {
    expect(resolveInheritedEnvironment({
      environments,
      projectDefaultEnvironmentId: "device",
      companyDefaultEnvironmentId: "ssh",
    })).toEqual({ environment: device, source: "project" });
    expect(resolveInheritedEnvironment({
      environments,
      companyDefaultEnvironmentId: "ssh",
      instanceDefaultEnvironmentId: "device",
    })).toEqual({ environment: ssh, source: "company" });
    expect(resolveInheritedEnvironment({ environments, instanceDefaultEnvironmentId: "device" }))
      .toEqual({ environment: device, source: "instance" });
    expect(resolveInheritedEnvironment({ environments })).toEqual({ environment: local, source: "local" });
  });

  it("skips a project or company default the adapter cannot run in, like the server", () => {
    expect(resolveInheritedEnvironment({
      environments,
      companyDefaultEnvironmentId: "device",
      adapterType: "http",
    })).toEqual({ environment: local, source: "local" });
  });

  it("labels the inherit option with where it resolves", () => {
    expect(inheritedEnvironmentLabel({ environment: device, source: "company" })).toBe(
      "Company default: Build computer · sandbox",
    );
    expect(inheritedEnvironmentLabel({ environment: null, source: "local" })).toBe(
      "Default: This Paperclip host",
    );
  });
});
