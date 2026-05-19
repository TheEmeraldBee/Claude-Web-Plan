import type { ComponentChildren, JSX } from "preact";

export type PlanStatus = "designing" | "ready" | "implemented" | "rejected";

export interface PlanProps {
  title: string;
  status?: PlanStatus;
  children: ComponentChildren;
}

export interface BlockProps {
  id: string;
  kind: string;
  title?: string;
  children: ComponentChildren;
}

export interface CalloutProps {
  variant?: "info" | "warn" | "danger";
  children: ComponentChildren;
}

export interface StepItem {
  title: string;
  text?: string;
}
export interface StepListProps {
  steps: StepItem[];
}

export interface FileItem {
  path: string;
  desc: string;
}
export interface FileListProps {
  items: FileItem[];
}

export type DecisionKind = "single" | "multi" | "freeform";
export interface DecisionOption {
  value: string;
  hint?: string;
}
export interface DecisionQuestion {
  text: string;
  help?: string;
  kind: DecisionKind;
  options?: DecisionOption[];
  placeholder?: string;
  allow_other?: boolean;
}
export interface DecisionPanelProps {
  questions: DecisionQuestion[];
}

export interface MermaidProps {
  children: string;
}

export interface ArchNode {
  title: string;
  body: string;
}
export interface ArchProps {
  nodes: ArchNode[];
}

export interface SequenceMessage {
  lane: string;
  text: string;
  variant?: "block" | "push" | "resp" | "user" | "default";
}
export interface SequenceProps {
  lanes: string[];
  messages: SequenceMessage[];
}

export interface TreeNode {
  name: string;
  desc?: string;
  children?: TreeNode[];
}
export interface TreeProps {
  root: TreeNode;
}

export interface TimelineMarker {
  label: string;
  at: string;
  done?: boolean;
}
export interface TimelineProps {
  markers: TimelineMarker[];
}

export type ClaudeState =
  | "idle"
  | "thinking"
  | "asking"
  | "waiting"
  | "implementing"
  | "errored";

export interface StateChipsProps {
  current?: ClaudeState;
}

export interface CodeBlockProps {
  lang?: string;
  children: string;
}

export type AnyJSX = JSX.Element;
