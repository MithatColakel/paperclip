// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceExecutionDeviceSummary } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { DeviceLinkDialog, type DeviceLinkRequest } from "./DeviceLinkDialog";

const mocks = vi.hoisted(() => ({ listInstance: vi.fn(), linkTarget: vi.fn() }));

vi.mock("@/api/execution-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/execution-devices")>();
  return { ...actual, executionDevicesApi: { ...actual.executionDevicesApi, ...mocks } };
});

const PLUGIN_ID = "0b9a3c52-1f0e-4a77-9b51-6d9c2a1e4f10";

function device(overrides: Partial<InstanceExecutionDeviceSummary>): InstanceExecutionDeviceSummary {
  return {
    id: "dev",
    name: "Device",
    kind: "ssh_host",
    maxAccounts: 3,
    limit: 3,
    inUse: 0,
    overLimit: false,
    overLimitSince: null,
    externalKey: null,
    targetKey: null,
    targetProvider: null,
    targetMatch: null,
    targetReportedAt: null,
    managedByPluginId: null,
    managedByPluginName: null,
    owner: null,
    aliases: [],
    servedCompanyIds: [],
    availability: {
      state: "available",
      reason: null,
      label: null,
      message: null,
      unavailableSince: null,
      retryAfter: null,
      checkedAt: null,
      acceptedCredentialTypes: null,
    },
    acceptedCredentialTypes: null,
    environments: [],
    accounts: [],
    companies: [],
    duplicateHints: [],
    createdAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

const SSH = device({ id: "dev-ssh", name: "SSH · tunnel", kind: "ssh_host" });
const LINKED_SSH = device({ id: "dev-linked", name: "SSH · linked", kind: "mac", targetKey: `target:${PLUGIN_ID}:remote-box:other` });
const STUDIO = device({ id: "dev-studio", name: "Studio", kind: "external", targetKey: `target:${PLUGIN_ID}:remote-box:studio` });

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderDialog(request: DeviceLinkRequest) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DeviceLinkDialog request={request} onClose={() => undefined} />
      </QueryClientProvider>,
    );
  });
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

function linkButton() {
  return [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Link devices");
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.body.innerHTML = "";
});

describe("DeviceLinkDialog", () => {
  it("names both devices and why they look like one machine", async () => {
    mocks.listInstance.mockResolvedValue({ limitPerDevice: 3, devices: [SSH, STUDIO] });
    await renderDialog({ deviceId: STUDIO.id, hint: { deviceId: SSH.id, deviceName: SSH.name, matchedBy: "label" } });
    await eventually(() => expect(document.body.textContent).toContain("Link SSH · tunnel and Studio?"));
    expect(document.body.textContent).toContain(
      "They look like the same machine: the plugin's name for Studio is the name of an SSH environment that reaches SSH · tunnel.",
    );
    expect(linkButton()?.disabled).toBe(false);
  });

  it("refuses a pair the server would refuse, without calling it", async () => {
    mocks.listInstance.mockResolvedValue({ limitPerDevice: 3, devices: [LINKED_SSH, STUDIO] });
    await renderDialog({ deviceId: LINKED_SSH.id, hint: { deviceId: STUDIO.id, deviceName: STUDIO.name, matchedBy: "alias" } });
    await eventually(() => expect(document.body.textContent).toContain("These two cannot be linked."));
    expect(linkButton()?.disabled).toBe(true);
    expect(mocks.linkTarget).not.toHaveBeenCalled();
  });

  it("explains that only instance admins can link", async () => {
    mocks.listInstance.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    await renderDialog({ deviceId: SSH.id, hint: { deviceId: STUDIO.id, deviceName: STUDIO.name, matchedBy: "alias" } });
    await eventually(() => expect(document.body.textContent).toContain("Only instance admins can link devices."));
    expect(linkButton()?.disabled).toBe(true);
  });
});
