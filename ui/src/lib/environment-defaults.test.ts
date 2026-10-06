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
const mac = makeEnvironment({ id: "mac", name: "Build Mac", driver: "sandbox", config: { provider: "mac-fleet" } });
const ssh = makeEnvironment({ id: "ssh", name: "Runner", driver: "ssh" });
const archived = makeEnvironment({ id: "old", name: "Old", driver: "ssh", status: "archived" });
const fake = makeEnvironment({ id: "fake", name: "Fake", driver: "sandbox", config: { provider: "fake" } });

describe("environment pickers", () => {
  it("offers active, runnable environments only", () => {
    expect(selectableEnvironments([local, mac, ssh, archived, fake]).map((env) => env.id)).toEqual([
      "local",
      "mac",
      "ssh",
    ]);
    // A local-only adapter cannot run on remote machines.
    expect(selectableEnvironments([local, mac, ssh], "http").map((env) => env.id)).toEqual(["local"]);
  });

  it("only asks when somewhere other than the local host exists", () => {
    expect(hasRemoteEnvironmentChoice([local])).toBe(false);
    expect(hasRemoteEnvironmentChoice([local, archived, fake])).toBe(false);
    expect(hasRemoteEnvironmentChoice([local, mac])).toBe(true);
  });
});

describe("resolveInheritedEnvironment", () => {
  const environments = [local, mac, ssh];

  it("walks project, company, instance, then the local host", () => {
    expect(resolveInheritedEnvironment({
      environments,
      projectDefaultEnvironmentId: "mac",
      companyDefaultEnvironmentId: "ssh",
    })).toEqual({ environment: mac, source: "project" });
    expect(resolveInheritedEnvironment({
      environments,
      companyDefaultEnvironmentId: "ssh",
      instanceDefaultEnvironmentId: "mac",
    })).toEqual({ environment: ssh, source: "company" });
    expect(resolveInheritedEnvironment({ environments, instanceDefaultEnvironmentId: "mac" }))
      .toEqual({ environment: mac, source: "instance" });
    expect(resolveInheritedEnvironment({ environments })).toEqual({ environment: local, source: "local" });
  });

  it("skips a project or company default the adapter cannot run in, like the server", () => {
    expect(resolveInheritedEnvironment({
      environments,
      companyDefaultEnvironmentId: "mac",
      adapterType: "http",
    })).toEqual({ environment: local, source: "local" });
  });

  it("labels the inherit option with where it resolves", () => {
    expect(inheritedEnvironmentLabel({ environment: mac, source: "company" })).toBe(
      "Company default: Build Mac · sandbox",
    );
    expect(inheritedEnvironmentLabel({ environment: null, source: "local" })).toBe(
      "Default: This Paperclip host",
    );
  });
});
