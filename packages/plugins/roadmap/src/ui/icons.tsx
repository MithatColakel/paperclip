import type { ReactNode } from "react";
import { sp } from "./styles.ts";

interface IconProps {
  size?: number;
  title?: string;
}

function Icon({ size = 4, title, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{ width: sp(size), height: sp(size), flex: "none" }}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Roadmap: three staggered bars on a timeline. */
export function RoadmapIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h9" />
      <path d="M8 12h11" />
      <path d="M6 18h7" />
      <path d="M3 3v18" />
    </Icon>
  );
}

export function ChevronIcon({ open, ...props }: IconProps & { open: boolean }) {
  return (
    <Icon {...props}>
      {open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Icon>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </Icon>
  );
}

export function BugIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6a4 4 0 0 1 8 0" />
      <rect x="6" y="6" width="12" height="14" rx="6" />
      <path d="M12 10v10" />
      <path d="M3 13h3" />
      <path d="M18 13h3" />
    </Icon>
  );
}

export function EpicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Icon>
  );
}

export function RepeatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </Icon>
  );
}
