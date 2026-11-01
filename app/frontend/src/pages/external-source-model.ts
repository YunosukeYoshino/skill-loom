import type {
  ExternalSourceDetailPayload,
  InstalledExternal,
  Tristate,
} from "../../../shared/api-types";

export function externalGlobalSelection(
  installed: InstalledExternal[],
  on: boolean
): Record<string, Tristate> {
  const state = on ? "active" : "off";
  return Object.fromEntries(
    installed
      .filter((skill) => (skill.state === "active") !== on)
      .map((skill) => [skill.name, state])
  );
}

export function updateExternalGlobal(
  data: ExternalSourceDetailPayload,
  states: Record<string, Tristate>
): ExternalSourceDetailPayload {
  return {
    ...data,
    message: "",
    installed: data.installed.map((skill) =>
      skill.name in states
        ? {
            ...skill,
            state: states[skill.name]!,
            hasUpdate:
              states[skill.name] === "active" ? skill.hasUpdate : false,
          }
        : skill
    ),
    updatable: data.updatable.filter((name) => states[name] !== "off"),
  };
}

export function externalSourceActivity(pending: {
  updateAll: boolean;
  updateOne: boolean;
  remove: boolean;
  removeSource: boolean;
  install: boolean;
  applyGlobal: boolean;
}) {
  const tasks = [
    { pending: pending.updateAll, text: "status.updateSource" },
    { pending: pending.updateOne, text: "status.updateSkill" },
    {
      pending: pending.remove || pending.removeSource,
      text: "status.removing",
    },
    { pending: pending.install, text: "status.installing" },
    { pending: pending.applyGlobal, text: "status.applyingGlobal" },
  ] as const;
  return tasks.find((task) => task.pending)?.text;
}
