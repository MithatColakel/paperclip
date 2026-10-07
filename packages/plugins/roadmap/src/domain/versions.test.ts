import { describe, expect, it } from "vitest";
import { labelTraits, pickVersionSpelling, versionKeyFromLabel, versionLabelColor } from "./labels.ts";
import { compareVersionKeys, isPatchKey, parseVersionKey, sortVersionKeys } from "./versions.ts";

describe("version label parsing", () => {
  it("reads the key from v:<key> labels", () => {
    expect(versionKeyFromLabel("v:mvp")).toBe("mvp");
    expect(versionKeyFromLabel("V: 1.0 ")).toBe("1.0");
    expect(versionKeyFromLabel("v:onb-1.0")).toBe("onb-1.0");
  });

  it("ignores labels that are not version labels", () => {
    expect(versionKeyFromLabel("v:")).toBeNull();
    expect(versionKeyFromLabel("version")).toBeNull();
    expect(versionKeyFromLabel("type:epic")).toBeNull();
    expect(versionKeyFromLabel("dev:v:1.0")).toBeNull();
  });

  it("collects traits case-insensitively and sorts version keys", () => {
    const traits = labelTraits([
      { name: "v:1.1" },
      { name: "Type:Epic" },
      { name: "type:hotfix" },
      { name: "TYPE:BUG" },
      { name: "release-ops" },
      { name: "v:mvp" },
      { name: "design" },
    ]);
    expect(traits).toEqual({
      versionKeys: ["mvp", "1.1"],
      versionSpellings: { mvp: "mvp", "1.1": "1.1" },
      isEpic: true,
      isHotfix: true,
      isBug: true,
      isReleaseOps: true,
    });
    expect(labelTraits(undefined).versionKeys).toEqual([]);
  });
});

describe("version key ordering", () => {
  it("puts mvp first, numeric keys in natural order and patches after their base", () => {
    const keys = ["1.10", "beta", "1.1", "onb-1.0", "1.0.1", "mvp", "1.0", "1.2", "1.0-rc1", "onb-mvp", "2.0"];
    expect(sortVersionKeys(keys)).toEqual([
      "mvp",
      "1.0-rc1",
      "1.0",
      "1.0.1",
      "1.1",
      "1.2",
      "1.10",
      "2.0",
      "beta",
      "onb-mvp",
      "onb-1.0",
    ]);
  });

  it("is a strict, symmetric order", () => {
    expect(compareVersionKeys("1.0", "1.0")).toBe(0);
    expect(Math.sign(compareVersionKeys("1.0", "1.0.1"))).toBe(-1);
    expect(Math.sign(compareVersionKeys("1.0.1", "1.0"))).toBe(1);
    expect(Math.sign(compareVersionKeys("MVP", "1.0"))).toBe(-1);
    expect(Math.sign(compareVersionKeys("1.0.0", "1.0"))).toBe(1);
  });

  it("deduplicates keys", () => {
    expect(sortVersionKeys(["1.0", "1.0", "mvp"])).toEqual(["mvp", "1.0"]);
  });

  it("parses prefixes and suffixes", () => {
    expect(parseVersionKey("onb-1.2.3")).toMatchObject({ prefix: "onb", rank: 1, nums: [1, 2, 3], suffix: "" });
    expect(parseVersionKey("1.0-rc1")).toMatchObject({ prefix: "", rank: 1, nums: [1, 0], suffix: "-rc1" });
    expect(parseVersionKey("q3-launch")).toMatchObject({ prefix: "", rank: 2 });
  });

  it("detects patch keys", () => {
    expect(isPatchKey("1.0.1")).toBe(true);
    expect(isPatchKey("onb-2.1.4")).toBe(true);
    expect(isPatchKey("1.0")).toBe(false);
    expect(isPatchKey("1.0.0")).toBe(false);
    expect(isPatchKey("mvp")).toBe(false);
  });
});

describe("keys other companies use", () => {
  it("keeps mvp variants after mvp, reads a leading v and sorts other suffixes after the plain key", () => {
    const keys = ["mvp", "mvp-2", "mvp2", "1.0", "1.0.1", "1.1", "2.0", "beta", "v1.0", "1.0.0", "1.0-hotfix", "1.0-rc1", "v2.0-beta.1"];
    expect(sortVersionKeys(keys)).toEqual([
      "mvp",
      "mvp-2",
      "mvp2",
      "1.0-rc1",
      "1.0",
      "v1.0",
      "1.0-hotfix",
      "1.0.0",
      "1.0.1",
      "1.1",
      "v2.0-beta.1",
      "2.0",
      "beta",
    ]);
  });

  it("never reads mvp or a bare v as a project prefix", () => {
    expect(parseVersionKey("mvp-2")).toMatchObject({ prefix: "", rank: 0, suffix: "-2", preRelease: false });
    expect(parseVersionKey("v1.0")).toMatchObject({ prefix: "", rank: 1, nums: [1, 0], suffix: "" });
    expect(parseVersionKey("v-1.2")).toMatchObject({ prefix: "", rank: 1, nums: [1, 2] });
    expect(parseVersionKey("onb-v1.0")).toMatchObject({ prefix: "onb", rank: 1, nums: [1, 0] });
    expect(parseVersionKey("mvp-rc1")).toMatchObject({ rank: 0, preRelease: true });
    expect(isPatchKey("v1.0.1")).toBe(true);
  });
});

describe("case variants", () => {
  it("groups v:MVP and v:mvp under one lowercase key and keeps each spelling", () => {
    const traits = labelTraits([{ name: "v:MVP" }, { name: "v:mvp" }, { name: "v:1.0" }]);
    expect(traits.versionKeys).toEqual(["mvp", "1.0"]);
    expect(traits.versionSpellings).toEqual({ mvp: "mvp", "1.0": "1.0" });
    expect(labelTraits([{ name: "v:MVP" }]).versionSpellings).toEqual({ mvp: "MVP" });
  });

  it("prefers the lowercase spelling, else the first one, whatever the order", () => {
    expect(pickVersionSpelling(["MVP", "mvp", "Mvp"])).toBe("mvp");
    expect(pickVersionSpelling(["Mvp", "MVP"])).toBe("MVP");
    expect(pickVersionSpelling(["MVP", "Mvp"])).toBe("MVP");
    expect(pickVersionSpelling([])).toBeNull();
  });

  it("finds the label colour in any case", () => {
    expect(versionLabelColor([{ name: "v:MVP", color: "label-colour" }], "mvp")).toBe("label-colour");
  });
});
