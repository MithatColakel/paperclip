// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  listEnvironments: vi.fn(),
  companies: [] as Array<{ id: string; defaultEnvironmentId: string | null }>,
}));

vi.mock("../api/projects", () => ({ projectsApi: {
  create: mocks.createProject,
  repositoryOptions: vi.fn().mockResolvedValue({ repositories: [], connectionCount: 0, failedConnectionCount: 0 }),
} }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: mocks.listEnvironments } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: {
  get: vi.fn().mockResolvedValue({ defaultEnvironmentId: null }),
  getExperimental: vi.fn().mockResolvedValue({}),
} }));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ newProjectOpen: true, closeNewProject: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", companies: mocks.companies }),
}));

const LOCAL = { id: "local-1", name: "Local", driver: "local", status: "active", config: {}, metadata: { defaultForInstance: true } };
const MAC = { id: "mac-1", name: "Build Mac", driver: "sandbox", status: "active", config: { provider: "mac-fleet" }, metadata: null };

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <NewProjectDialog />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function picker() {
  return document.body.querySelector<HTMLSelectElement>("#new-project-environment");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.companies = [{ id: "company-1", defaultEnvironmentId: null }];
  mocks.createProject.mockResolvedValue({ id: "project-1" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("NewProjectDialog — where the project runs", () => {
  it("hides the question when the local host is the only environment", async () => {
    mocks.listEnvironments.mockResolvedValue([LOCAL]);
    await render();
    expect(picker()).toBeNull();
  });

  it("asks where the work runs and sends the pick with the new project", async () => {
    mocks.listEnvironments.mockResolvedValue([LOCAL, MAC]);
    mocks.companies = [{ id: "company-1", defaultEnvironmentId: "mac-1" }];
    await render();

    const select = picker();
    expect(select).not.toBeNull();
    expect(document.body.textContent).toContain("Where does this project's work run?");
    expect(select!.options[0].textContent).toBe("Company default: Build Mac · sandbox");

    const name = document.body.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Cleanio iOS");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "mac-1");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const submit = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create project",
    )!;
    await act(async () => submit.click());
    await settle();

    expect(mocks.createProject).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "Cleanio iOS",
      defaultEnvironmentId: "mac-1",
    }));
  });

  it("leaves the project on the inherited default when nothing is picked", async () => {
    mocks.listEnvironments.mockResolvedValue([LOCAL, MAC]);
    await render();
    const name = document.body.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Docs");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create project",
    )!;
    await act(async () => submit.click());
    await settle();
    expect(mocks.createProject.mock.calls[0][1]).not.toHaveProperty("defaultEnvironmentId");
  });
});
