import { describe, expect, it } from "vitest";
import { resourceWaitRefusalNextAction } from "./service.js";
import { resourceWaitRefusalNoticeSeed } from "./resource-wait-refusal-notice.js";

describe("resource-wait refusal next actions (fork)", () => {
  it("names each refusal's own fix, as its blocked-task notice does", () => {
    expect(resourceWaitRefusalNextAction("environment_refused")).toBe(
      "Board operator: move the agent to another environment, or ask the owner of the device named in the run failure to check it, then explicitly retry the original owner or reassign.",
    );
    expect(resourceWaitRefusalNextAction("ai_connection_incompatible")).toContain("remove the routing override or authentication setting");
    expect(resourceWaitRefusalNextAction("ai_connection_changed")).toContain("start a new execution of the task");
    for (const reason of ["environment_refused", "ai_connection_incompatible", "ai_connection_changed"]) {
      expect(resourceWaitRefusalNoticeSeed({ reason })).not.toBeNull();
      expect(resourceWaitRefusalNextAction(reason)).not.toContain("missing secret");
    }
  });

  it("leaves every other reason to the secret-binding text", () => {
    for (const reason of ["secret_binding_missing", "ai_connection_unavailable", "", null, undefined, 42]) {
      expect(resourceWaitRefusalNextAction(reason)).toBeNull();
    }
  });
});
