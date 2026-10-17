// A plugin worker for the environment-target host tests. On getData,
// performAction or an onEvent notification it makes one nested host call that
// the call's params describe ({hostMethod, hostParams, forge}), echoing the
// host-issued invocation id. With `forge`, it also puts a made-up invocation
// scope on its own message, which the host must ignore.
const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function probeOf(message) {
  if (message.method === "onEvent") return message.params?.event?.payload?.probe ?? {};
  return message.params?.params?.probe ?? {};
}

function callHost(message) {
  const probe = probeOf(message);
  const invocationId = message.paperclipInvocation?.id;
  const nestedId = `nested-${nextRequestId++}`;
  const nested = {
    jsonrpc: "2.0",
    id: nestedId,
    method: probe.hostMethod || "environments.ensureCompanyEnvironment",
    params: probe.hostParams || {},
  };
  if (invocationId) nested.paperclipInvocationId = invocationId;
  if (probe.forge) {
    nested.paperclipInvocation = { id: invocationId, scope: probe.forge };
    nested.invocationScope = probe.forge;
  }
  if (message.id !== undefined) pendingNested.set(nestedId, message.id);
  send(nested);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id !== undefined && pendingNested.has(message.id)) {
    const originalId = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    send(message.error
      ? { jsonrpc: "2.0", id: originalId, error: message.error }
      : { jsonrpc: "2.0", id: originalId, result: message.result });
    return;
  }
  // The answer to a nested call made for a notification: nobody waits for it.
  if (message.id !== undefined && typeof message.id === "string" && message.id.startsWith("nested-")) return;

  const method = typeof message.method === "string" ? message.method : null;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData", "performAction", "onEvent"] } });
    return;
  }
  if (method === "getData" || method === "performAction" || method === "onEvent") {
    callHost(message);
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${method}` } });
  }
});
