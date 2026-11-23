export type Project = { name: string; path: string; deck?: string };
export type ProjectSource = "custom" | "vendor" | "external";
export type ProjectSkillState =
  | "managed"
  | "drifted"
  | "unmanaged"
  | "conflict"
  | "unavailable"
  | "missing";
export type ProjectSkill = {
  name: string;
  displayName: string;
  description: string;
  state: ProjectSkillState;
  managed: boolean;
  globalActive: boolean;
  inventory: boolean;
  available: boolean;
  locations: string[];
  sourceVersion: string | null;
};
export type ProjectChange = {
  name: string;
  action: "add" | "update" | "remove" | "skip";
  reason?: string;
};
export type ProjectPreview = {
  skill: string;
  diff: string;
  revision: string;
  requiresConfirmation: boolean;
};
export type ProjectStatus = {
  project: Project;
  state: "ready" | "missing";
  dirty: boolean | null;
  deckError?: string;
  skills: ProjectSkill[];
  plan: ProjectChange[];
  review?: { revision: string; diff: string };
};
export type ProjectList = {
  projects: Project[];
  inventory: string[];
  decks: string[];
};
