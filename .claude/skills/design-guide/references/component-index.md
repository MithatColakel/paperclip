# Paperclip Component Index

Complete inventory of all UI components. Update this file when adding new reusable components.

---

## Table of Contents

1. [shadcn/ui Primitives](#shadcnui-primitives)
2. [Custom Components](#custom-components)
3. [Layout Components](#layout-components)
4. [Dialog & Form Components](#dialog--form-components)
5. [Property Panel Components](#property-panel-components)
6. [Agent Configuration](#agent-configuration)
7. [Utilities & Hooks](#utilities--hooks)
8. [Claude Accounts and Devices](#claude-accounts-and-devices)

---

## shadcn/ui Primitives

Location: `ui/src/components/ui/`

These are shadcn/ui base components. Do not modify directly — extend via composition.

| Component | File | Key Props | Notes |
|-----------|------|-----------|-------|
| Button | `button.tsx` | `variant` (default, secondary, outline, ghost, destructive, link), `size` (xs, sm, default, lg, icon, icon-xs, icon-sm, icon-lg) | Primary interactive element. Uses CVA. |
| Card | `card.tsx` | CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter | Compound component. `py-6` default padding. |
| Input | `input.tsx` | `disabled` | Standard text input. |
| Badge | `badge.tsx` | `variant` (default, secondary, outline, destructive, ghost) | Generic label/tag. For status, use StatusBadge instead. |
| Label | `label.tsx` | — | Form label, wraps Radix Label. |
| Select | `select.tsx` | Trigger, Content, Item, etc. | Radix-based dropdown select. |
| Separator | `separator.tsx` | `orientation` (horizontal, vertical) | Divider line. |
| Checkbox | `checkbox.tsx` | `checked`, `onCheckedChange` | Radix checkbox with indicator. |
| Textarea | `textarea.tsx` | Standard textarea props | Multi-line input. |
| Avatar | `avatar.tsx` | `size` (sm, default, lg). Includes AvatarGroup, AvatarGroupCount | Image or fallback initials. |
| Breadcrumb | `breadcrumb.tsx` | BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage | Navigation breadcrumbs. |
| Command | `command.tsx` | CommandInput, CommandList, CommandGroup, CommandItem | Command palette / search. Based on cmdk. |
| Dialog | `dialog.tsx` | DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter | Modal overlay. |
| DropdownMenu | `dropdown-menu.tsx` | Trigger, Content, Item, Separator, etc. | Context/action menus. |
| Popover | `popover.tsx` | PopoverTrigger, PopoverContent | Floating content panel. |
| Tabs | `tabs.tsx` | `variant` (pill, line). TabsList, TabsTrigger, TabsContent | Tabbed navigation. Pill = default, line = underline style. |
| Tooltip | `tooltip.tsx` | TooltipTrigger, TooltipContent | Hover tooltips. App is wrapped in TooltipProvider. |
| ScrollArea | `scroll-area.tsx` | — | Custom scrollable container. |
| Collapsible | `collapsible.tsx` | CollapsibleTrigger, CollapsibleContent | Expand/collapse sections. |
| Skeleton | `skeleton.tsx` | className for sizing | Loading placeholder with shimmer. |
| Sheet | `sheet.tsx` | SheetTrigger, SheetContent, SheetHeader, etc. | Side panel overlay. |

---

## Custom Components

Location: `ui/src/components/`

### StatusBadge

**File:** `StatusBadge.tsx`
**Props:** `status: string`
**Usage:** Colored pill showing entity status. Supports 20+ statuses with mapped colors.

```tsx
<StatusBadge status="in_progress" />
```

Use for displaying status in properties panels, entity rows, and list views. Never hardcode status colors — always use this component.

### StatusIcon

**File:** `StatusIcon.tsx`
**Props:** `status: string`, `onChange?: (status: string) => void`
**Usage:** Circle icon representing issue status. When `onChange` provided, opens a popover picker.

```tsx
<StatusIcon status="todo" onChange={setStatus} />
```

Supports: backlog, todo, in_progress, in_review, done, cancelled, blocked. Use in entity row leading slots and grouped list headers.

### PriorityIcon

**File:** `PriorityIcon.tsx`
**Props:** `priority: string`, `onChange?: (priority: string) => void`
**Usage:** Priority indicator icon. Interactive when `onChange` provided.

```tsx
<PriorityIcon priority="high" onChange={setPriority} />
```

Supports: critical, high, medium, low. Use alongside StatusIcon in entity row leading slots.

### EntityRow

**File:** `EntityRow.tsx`
**Props:** `leading`, `identifier`, `title`, `subtitle?`, `trailing?`, `onClick?`, `selected?`
**Usage:** Standard list row for issues, agents, projects. Supports hover highlight and selected state.

```tsx
<EntityRow
  leading={<><StatusIcon status="todo" /><PriorityIcon priority="medium" /></>}
  identifier="PAP-003"
  title="Write API documentation"
  trailing={<StatusBadge status="todo" />}
  onClick={() => navigate(`/issues/${id}`)}
/>
```

Wrap multiple EntityRows in a `border border-border rounded-md` container.

### MetricCard

**File:** `MetricCard.tsx`
**Props:** `icon: LucideIcon`, `value: string | number`, `label: string`, `description?: string`
**Usage:** Dashboard stat card with icon, large value, label, and optional description.

```tsx
<MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
```

Always use in a responsive grid: `grid md:grid-cols-2 xl:grid-cols-4 gap-4`.

### EmptyState

**File:** `EmptyState.tsx`
**Props:** `icon: LucideIcon`, `message: string`, `action?: string`, `onAction?: () => void`
**Usage:** Empty list placeholder with icon, message, and optional CTA button.

```tsx
<EmptyState icon={Inbox} message="No items yet." action="Create Item" onAction={handleCreate} />
```

### FilterBar

**File:** `FilterBar.tsx`
**Props:** `filters: FilterValue[]`, `onRemove: (key) => void`, `onClear: () => void`
**Type:** `FilterValue = { key: string; label: string; value: string }`
**Usage:** Filter chip display with remove buttons and clear all.

```tsx
<FilterBar filters={filters} onRemove={handleRemove} onClear={() => setFilters([])} />
```

### Identity

**File:** `Identity.tsx`
**Props:** `name: string`, `avatarUrl?: string`, `initials?: string`, `size?: "sm" | "default" | "lg"`
**Usage:** Avatar + name display for users and agents. Derives initials from name automatically. Three sizes matching Avatar sizes.

```tsx
<Identity name="Agent Alpha" size="sm" />
<Identity name="CEO Agent" />
<Identity name="Backend Service" size="lg" avatarUrl="/img/bot.png" />
```

Use in property rows, comment headers, assignee displays, and anywhere a user/agent reference is shown.

### InlineEditor

**File:** `InlineEditor.tsx`
**Props:** `value: string`, `onSave: (val: string) => void`, `as?: string`, `className?: string`
**Usage:** Click-to-edit text. Renders as display text, clicking enters edit mode. Enter saves, Escape cancels.

```tsx
<InlineEditor value={title} onSave={updateTitle} as="h2" className="text-xl font-bold" />
```

### PageSkeleton

**File:** `PageSkeleton.tsx`
**Props:** `variant: "list" | "detail"`
**Usage:** Full-page loading skeleton matching list or detail layout.

```tsx
<PageSkeleton variant="list" />
```

### CommentThread

**File:** `CommentThread.tsx`
**Usage:** Comment list with add-comment form. Used on issue and entity detail views.

### GoalTree

**File:** `GoalTree.tsx`
**Usage:** Hierarchical goal tree with expand/collapse. Used on the goals page.

### CompanySwitcher

**File:** `CompanySwitcher.tsx`
**Usage:** Company selector dropdown in sidebar header.

---

## Layout Components

### Layout

**File:** `Layout.tsx`
**Usage:** Main app shell. Three-zone layout: Sidebar + Main content + Properties panel. Wraps all routes.

### Sidebar

**File:** `Sidebar.tsx`
**Usage:** Left navigation sidebar (`w-60`). Contains CompanySwitcher, search button, new issue button, and SidebarSections.

### SidebarSection

**File:** `SidebarSection.tsx`
**Usage:** Collapsible sidebar group with header label and chevron toggle.

### SidebarNavItem

**File:** `SidebarNavItem.tsx`
**Props:** Icon, label, optional badge count
**Usage:** Individual nav item within a SidebarSection.

### BreadcrumbBar

**File:** `BreadcrumbBar.tsx`
**Usage:** Top breadcrumb navigation spanning main content + properties panel.

### PropertiesPanel

**File:** `PropertiesPanel.tsx`
**Usage:** Right-side properties panel (`w-80`). Closeable. Shown on detail views.

### CommandPalette

**File:** `CommandPalette.tsx`
**Usage:** Cmd+K global search modal. Searches issues, projects, agents.

---

## Dialog & Form Components

### NewIssueDialog

**File:** `NewIssueDialog.tsx`
**Usage:** Create new issue with project/assignee/priority selection. Supports draft saving.

### NewProjectDialog

**File:** `NewProjectDialog.tsx`
**Usage:** Create new project dialog.

### NewAgentDialog

**File:** `NewAgentDialog.tsx`
**Usage:** Create new agent dialog.

### OnboardingWizard

**File:** `OnboardingWizard.tsx`
**Usage:** Multi-step onboarding flow for new users/companies.

---

## Property Panel Components

These render inside the PropertiesPanel for different entity types:

| Component | File | Entity |
|-----------|------|--------|
| IssueProperties | `IssueProperties.tsx` | Issues |
| AgentProperties | `AgentProperties.tsx` | Agents |
| ProjectProperties | `ProjectProperties.tsx` | Projects |
| GoalProperties | `GoalProperties.tsx` | Goals |

All follow the property row pattern: `text-xs text-muted-foreground` label on left, value on right, `py-1.5` spacing.

---

## Agent Configuration

### agent-config-primitives

**File:** `agent-config-primitives.tsx`
**Exports:** Field, ToggleField, ToggleWithNumber, CollapsibleSection, AutoExpandTextarea, DraftInput
**Usage:** Reusable form field primitives for agent configuration forms.

### AgentConfigForm

**File:** `AgentConfigForm.tsx`
**Usage:** Full agent creation/editing form with adapter type selection.

---

## Utilities & Hooks

### cn() — Class Name Merger

**File:** `ui/src/lib/utils.ts`
**Usage:** Merges class names with clsx + tailwind-merge. Use in every component.

```tsx
import { cn } from "@/lib/utils";
<div className={cn("base-classes", conditional && "extra", className)} />
```

### Formatting Utilities

**File:** `ui/src/lib/utils.ts`

| Function | Usage |
|----------|-------|
| `formatCents(cents)` | Money display: `$12.34` |
| `formatDate(date)` | Date display: `Jan 15, 2025` |
| `relativeTime(date)` | Relative time: `2m ago`, `Jan 15` |
| `formatTokens(count)` | Token counts: `1.2M`, `500k` |

### useKeyboardShortcuts

**File:** `ui/src/hooks/useKeyboardShortcuts.ts`
**Usage:** Global keyboard shortcut handler. Registers Cmd+K, C, [, ], Cmd+Enter.

### Query Keys

**File:** `ui/src/lib/queryKeys.ts`
**Usage:** Structured React Query key factories for cache management.

### groupBy

**File:** `ui/src/lib/groupBy.ts`
**Usage:** Generic array grouping utility.

---

## Claude Accounts and Devices

Fork components of the Claude account pool and the waiting UI. A Claude agent uses one Claude account from its owner's pool, or its device's own login; Paperclip never moves a task to another account. A task whose device, account or device account slot is unavailable waits and starts on its own. The /design-guide page shows each one with sample data in its states (`ai-account-pool/AccountPoolDesignExamples.tsx`).

### AgentClaudeAccountField

**File:** `ai-account-pool/AgentClaudeAccountField.tsx`
**Props:** `agent: Pick<Agent, "id" | "name" | "companyId" | "adapterType">`, `aiConnection?: AiRuntimeConnectionBinding | null` (the agent's saved `runtimeConfig.aiConnection`, from `agentAiConnection(runtimeConfig)`), `environmentCredentials?: readonly ClaudeEnvironmentCredential[]` (from `claudeEnvironmentCredentials(adapterConfig.env)`: each Claude credential variable, and whether it holds each task's responsible person's own value from My secrets), `id?` (the anchor, default `claude-account`), `className?`, `now?: Date`
**Usage:** The one Claude account field of an existing Claude agent, in the Adapter section of its Configuration view in place of the AI connection field (`showsClaudeAccountField(savedAdapterType, formAdapterType)` decides). An `AccountSelect` offers the pool accounts and the device's own login (options, reasons and `canBindAny` come with `GET /api/agents/:id/ai-account`), plus the agent's AI connection only while the agent has no selection, as its current choice. The text under the picker says what the runs use now (`agentClaudeAccountUsageText`) and the next step where they cannot run for the viewer: a missing or expired own connection behind a responsible-user connection (a link to Apps), a Claude login the viewer has not saved under My secrets, or the credential variables to remove for the device's own login. A change saves at once, apart from the form's Save button, and applies from the next run; refusals show inline, never as a toast. Below: the agent's devices with their availability, the wait its tasks are in or would hit, the migrated-assignment review, and an "Add account" link to Company settings → Claude accounts. The page scrolls to the field when the URL's hash names its id (the overview's Change link).

```tsx
<AgentClaudeAccountField agent={agent} aiConnection={agentAiConnection(agent.runtimeConfig)} environmentCredentials={claudeEnvironmentCredentials(agent.adapterConfig.env)} />
```

The same file exports `AgentClaudeAccountLeftOver` (`agentId`, `className?`: for another adapter, the notice of a selection left from when the agent ran Claude, with Remove; nothing otherwise), `AgentClaudeAccountOverviewRows` (the overview's Device and Claude account rows, with a Change link to `changeHref`; without a selection the account row names the agent's AI connection from `agent.runtimeConfig` as the field does), `useHasClaudeAccountSelection(agentId | null)` (whether the field has loaded a selection; the form hides the sandbox sign-in then) and `AGENT_CLAUDE_ACCOUNT_FIELD_ID`.

States on /design-guide: an account at its usage limit, a migrated agent without an account (the review banner), the device's own login, read-only for a member who neither owns the account nor is a company admin, the agent's AI connection as the current choice, no selection, and a left-over selection.

### AccountSelect

**File:** `ai-account-pool/AccountSelect.tsx`
**Props:** `options: readonly CompanyAiAccountOption[]` (one agent's options, with `selectable`, `reason`, `warning` and `onAgentDevice`), `canBindAny: boolean`, `value: AccountSelectValue`, `onChange: (selection: SetAgentAiAccount) => void`, `includeDeviceLogin?`, `canSetDeviceLogin?` (defaults to `canBindAny`), `currentAiConnection?: { label: string } | null` (listed and selected with `value: { mode: "ai_connection" }` only while it is what the agent uses; picking it saves nothing), `showActiveState?` (the trigger also shows an Active badge), `disabled?`, `loading?`, `placeholder?`, `aria-label?`, `disablePortal?`, `className?`, `now?: Date`
**Usage:** Picks an agent's Claude account, or its device's own login. Accounts already on the agent's device come first (they take no new slot). Each option shows its state; an option the caller cannot choose stays visible, disabled, with the reason and its fix: another member's account for a caller who is not a company admin, a device at its limit of Claude accounts, a signed-out account. A limited account stays selectable, with a note that its tasks wait for the reset. An account's details (owner · plan · type) stay on one line; what the device's own login or the current AI connection means wraps, so it is read in full. `onChange` receives the body for `PUT /api/agents/:id/ai-account`; the server stays authoritative.

```tsx
<AccountSelect
  options={binding.options}
  canBindAny={canBindAny}
  value={accountSelectValueFromBinding(binding)}
  onChange={(selection) => save.mutate(selection)}
  includeDeviceLogin
  canSetDeviceLogin={canChooseDeviceLogin({ canBindAny, binding })}
/>
```

A company admin may choose any eligible account; everyone else only their own, and may switch an agent to the device's own login only while it uses one of their own accounts (`canChooseDeviceLogin`, decision D4).

### AiAccountStateBadge

**File:** `ai-account-pool/AccountSelect.tsx`
**Props:** `display: AiAccountStateDisplay` (from `aiAccountStateDisplay(account, now)` in `ui/src/lib/ai-account-pool.ts`), `className?`
**Usage:** A pool account's state: `Active`, `Limited until 18:00` (` (estimated)` for an estimated reset), `Signed out`, `Paused by owner`, `Disabled by admin`. Tones come from `POOL_BADGE_TONE_CLASS`.

```tsx
<AiAccountStateBadge display={aiAccountStateDisplay(account, now)} />
```

### ResourceWaitBanner

**File:** `ResourceWaitBanner.tsx`
**Props:** `issueId: string`, `scheduledRetry: IssueScheduledRetry | null | undefined`, `className?`
**Usage:** The waiting card of a task whose run waits for an execution device, a Claude account or a device account slot (`scheduledRetry.resourceWait`). It says what the task waits for and names the fix when a person has to act (warning tone; info when the wait ends on its own). It names whose run waits, with a link to the run, because that may be another agent's run than the assignee's. It ends with `ResourceWaitCheckNowButton`. A wait that joined another one may have no start time of its own (`since: null`); the copy then leaves the time out. Renders nothing unless the retry is a waiting resource-wait lane.

```tsx
<ResourceWaitBanner issueId={issue.id} scheduledRetry={issue.scheduledRetry} />
```

### ResourceWaitCheckNowButton

**File:** `ResourceWaitBanner.tsx`
**Props:** `issueId: string`, `className?`
**Usage:** "Check now" on a waiting task. It calls the existing retry-now route, which re-checks the resource first. The answer shows in place, never as a toast: `Available. Starting now.`, `Still unavailable (checked just now)` for a 409 `resource_still_unavailable`, a one-minute note for a 429, or the error.

```tsx
<ResourceWaitCheckNowButton issueId={issue.id} />
```

### ResourceWaitChip

**File:** `ResourceWaitBanner.tsx`
**Props:** `scheduledRetry: IssueScheduledRetry | null | undefined`, `selected?: boolean`
**Usage:** The task-row chip of a waiting task, e.g. `Waiting for device: Build box` or `Waiting for limit reset: 18:00 (estimated)`, with the banner's title and detail as its tooltip. `selected` mutes it inside a selected row.

```tsx
<ResourceWaitChip scheduledRetry={issue.scheduledRetry} selected={selected} />
```

### ResourceWaitPropertyValue

**File:** `ResourceWaitBanner.tsx`
**Props:** `scheduledRetry: IssueScheduledRetry | null | undefined`
**Usage:** The value of the properties panel's "Waiting" row, e.g. `device Build box (offline since 13:02)`.

```tsx
<ResourceWaitPropertyValue scheduledRetry={issue.scheduledRetry} />
```

### ResourceWaitLedgerEntry

**File:** `ResourceWaitBanner.tsx`
**Props:** `runs: readonly ResourceWaitLedgerRunLike[]` (newest first, a group from `collapseResourceWaitRuns`), `agentName: string`, `timestamp: string`
**Usage:** One run-ledger entry for consecutive wait runs of one agent and reason, `Waiting: device offline` or `Waited: device offline`, with the attempt count, the duration and links to the first five runs, instead of a column of cancellations.

```tsx
<ResourceWaitLedgerEntry runs={group.runs} agentName={agentName} timestamp={group.timestamp} />
```

### RunResourceWaitBadge

**File:** `ai-account-pool/RunResourceWaitBadge.tsx`
**Props:** `run: ResourceWaitRunLike`, `className?`
**Usage:** A run row's badge for a resource wait: `Waited` for a deferral (no provider work started), `Waiting` for its successor, `Resumed` once the successor ran. Renders nothing for other runs. Never shows a wait as a failure or a retry.

```tsx
<RunResourceWaitBadge run={run} />
```

### DeviceLinkDialog

**File:** `ai-accounts/DeviceLinkDialog.tsx`
**Props:** `request: DeviceLinkRequest | null` (`{ deviceId, hint }` from a device's duplicate hints), `onClose: () => void`
**Usage:** Instance admins link one machine reached two ways (an SSH environment and an environment driver plugin) into one device, so both share one limit of Claude accounts. Opens while `request` is set; reads the instance device list, explains the merge, and says when a pair cannot be linked.

```tsx
<DeviceLinkDialog request={linkRequest} onClose={() => setLinkRequest(null)} />
```

Used by the company Devices page and the instance Devices & Claude accounts page.
