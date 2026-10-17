import type { StrandedRecoveryNoticeSeed } from "./stranded-notice.js";

function readNonEmptyStringField(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Fork: the blocked-task notice for a run refused instead of waiting (spec
 * 4.2, 4.4, 6.3 and 7.1). `configurationIncomplete` is the payload the
 * refused run recorded in `resultJson`. Each notice names its own fix
 * instead of the missing-secret fallback. `ai_connection_incompatible` and
 * `ai_connection_changed` are also upstream reasons (managed AI
 * connections), so their copy fits both. Null for every other reason.
 */
export function resourceWaitRefusalNoticeSeed(
  configurationIncomplete: Record<string, unknown> | null | undefined,
): StrandedRecoveryNoticeSeed | null {
  switch (readNonEmptyStringField(configurationIncomplete, "reason")) {
    case "environment_refused": {
      // The agent's execution device was removed or refuses its runs, so the fix is a move.
      const device = (readNonEmptyStringField(configurationIncomplete, "deviceName")
        ?? readNonEmptyStringField(configurationIncomplete, "environmentName"))?.replaceAll("`", "'");
      return {
        body:
          `Paperclip stopped before dispatching the adapter because ${device ? `the execution device \`${device}\`` : "the agent's execution device"} ` +
          "was removed or refuses this agent's runs. Moving it to `blocked` so an operator can move the agent to another " +
          "environment, or ask the device's owner to check it, before resuming.",
        title: "Execution device refused the run",
        nextAction: "Move the agent to another environment, or ask the device's owner to check the device, then resume the task.",
        tone: "danger",
      };
    }
    case "ai_connection_incompatible":
      // A provider routing override, or an authentication setting, that would route the account's credential elsewhere.
      return {
        body:
          "Paperclip stopped before dispatching the adapter because a provider routing override or an authentication setting " +
          "conflicts with this agent's AI account, or the project's settings could not be checked. The run failure names the " +
          "setting and where it is set: the run's environment variables, or the project's settings such as `.claude/settings.json`. " +
          "Moving it to `blocked` so an operator can remove that setting before resuming.",
        title: "AI account blocked by a conflicting setting",
        nextAction: "Remove the routing override or authentication setting named in the run failure, then resume the task.",
        tone: "danger",
      };
    case "ai_connection_changed":
      // A suspended native run whose account changed or is gone (spec 4.2 row 0). It never continues on another account.
      return {
        body:
          "Paperclip stopped before resuming the suspended native run because the AI account it used changed or is no longer " +
          "available, and a suspended run never continues on another account. Moving it to `blocked` so an operator can start " +
          "a new execution, which uses the agent's current AI account.",
        title: "AI account of a suspended run changed",
        nextAction: "Start a new execution of the task; it uses the agent's current AI account.",
        tone: "danger",
      };
    default:
      return null;
  }
}
