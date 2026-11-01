/** スキル閲覧と Fork 作業の公開 API。パスはスキル内の相対パス。 */
export type SkillRef = {
  name: string;
  source?: string;
  skillPath?: string;
};

export type SkillVersion =
  | "source"
  | "upstream"
  | "work"
  | "installed"
  | "baseline";

export type UpstreamVersion = { commit: string; date: string };

export type SkillUpstreamStatus = {
  state:
    | "unchecked"
    | "current"
    | "behind"
    | "missing"
    | "unavailable"
    | "review"
    | "unknown";
  baseline?: UpstreamVersion;
  latest?: UpstreamVersion;
  behind: number | null;
  checkedAt?: string;
  attemptedAt?: string;
  message?: string;
};

export type SkillFile = { path: string; size: number; binary: boolean };

export type SkillView = {
  ref: SkillRef;
  kind: "custom" | "external" | "vendor" | "draft" | "untracked";
  version: SkillVersion;
  versions: SkillVersion[];
  files: SkillFile[];
  selectedFile: string;
  content: string | null;
  html: string | null;
  binary: boolean;
  truncated: boolean;
  revision: string;
  workspace?: {
    dirty: boolean;
    conflicts: string[];
    issues: string[];
    baseChanged: boolean;
  };
  diff: string;
  upstream: SkillUpstreamStatus;
  message?: string;
};

export type SkillCodexState = {
  status: "idle" | "starting" | "running" | "approval" | "failed";
  threadId?: string;
  messages: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  approvals: Array<{ id: string | number; title: string; detail: string }>;
  error?: string;
};
