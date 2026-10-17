import type {
  HostToWorkerMethodName,
  PluginInvocationActor,
  PluginInvocationScope,
  PluginPerformActionActorType,
  WorkerHostCallContext,
} from "@paperclipai/plugin-sdk";

/**
 * Fork: host-derived facts of a plugin invocation (spec 9.6).
 *
 * The worker manager records a company scope for every host→worker call that
 * names a company. This adds the method that opened the invocation and, for
 * `performAction`, the actor the host resolved for the request
 * (`params.actorContext`, built by the plugin bridge routes). Both come from
 * the host's own call parameters: a worker only echoes the invocation id on
 * its nested calls, so it can never supply or change them. Host handlers read
 * them from the call context.
 */

const ACTOR_TYPES: ReadonlySet<string> = new Set<PluginPerformActionActorType>(["user", "agent", "system"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The actor of a `performAction` call, from the actor context the host built; null when it has none. */
function performActionActor(params: unknown): PluginInvocationActor | null {
  const actorContext = isRecord(params) ? params.actorContext : null;
  if (!isRecord(actorContext) || typeof actorContext.type !== "string" || !ACTOR_TYPES.has(actorContext.type)) {
    return null;
  }
  const type = actorContext.type as PluginPerformActionActorType;
  return { type, userId: type === "user" ? readNonEmptyString(actorContext.userId) : null };
}

/**
 * The company scope of a host→worker call plus the host-derived facts:
 * `method`, and for `performAction` the `actor`. Null stays null (the call
 * opens no company invocation).
 */
export function withHostInvocationFacts(
  scope: PluginInvocationScope | null,
  method: HostToWorkerMethodName | string,
  params: unknown,
): PluginInvocationScope | null {
  if (!scope) return null;
  const facts: PluginInvocationScope = { ...scope, method: method as HostToWorkerMethodName };
  if (method === "performAction") {
    const actor = performActionActor(params);
    if (actor) facts.actor = actor;
  }
  return facts;
}

/**
 * The board user behind the current invocation: a `performAction` whose
 * host-derived actor is a user with an id. Null for anything else, also for
 * a missing, expired or unknown invocation.
 */
export function invocationBoardUser(
  context: WorkerHostCallContext | null | undefined,
): { companyId: string; userId: string } | null {
  if (!context || context.invalidInvocationScope) return null;
  const scope = context.invocationScope;
  const companyId = readNonEmptyString(scope?.companyId);
  const userId = scope?.actor?.type === "user" ? readNonEmptyString(scope.actor.userId) : null;
  if (scope?.method !== "performAction" || !companyId || !userId) return null;
  return { companyId, userId };
}
