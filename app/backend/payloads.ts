/**
 * SPA API のレスポンス payload 組み立て。
 *
 * `ui/payloads.py` の移植。キーの並びまで含めて移行前と一致させる（JSON の
 * オブジェクトキーは挿入順で出るので、並びが変わると差分に見えてしまう）。
 */

import type {
  Counts,
  DraftsPayload,
  ExternalPreviewPayload,
  ExternalSourceDetailPayload,
  ExternalSourcesPayload,
  GlobalPayload,
  ProjectDeckPayload,
  InstalledExternal,
  SkillRow,
} from "@shared/api-types";
import {
  listProjectDecks,
  loadDeck,
  projectDeckInstallCommands,
} from "./domain/decks";
import { draftRows } from "./domain/drafts";
import {
  activeExternalSkillNames,
  externalSourceStatusLabel,
  externalSourceSummary,
  externalUpdateCommand,
  skillHasRemoteUpdate,
  type SourceUpdateStatus,
} from "./domain/external";
import { activeDir, archiveDir } from "./domain/config";
import type { ExternalCandidate } from "./infrastructure/github";
import { normalizeGithubSource } from "./infrastructure/github";
import {
  allSkillNames,
  globalTristateRows,
  type Lock,
  managedActiveSkills,
  skillDescription,
  skillProjectionState,
  skillRows,
  sortNames,
  type TristateRow,
  visibleInstalledNames,
} from "./domain/inventory";
import { hasPreviousPreset, listUserPresets } from "./domain/presets";

function shellCommandText(command: string[]): string {
  return command
    .map((value) => {
      if (value === "") return "''";
      if (!/[^\w@%+=:,./-]/.test(value)) return value;
      return `'${value.replaceAll("'", `'"'"'`)}'`;
    })
    .join(" ");
}

export function deckNames(): string[] {
  return listProjectDecks();
}

export function countsDict(
  mainRows: TristateRow[],
  archivedRows: TristateRow[]
): Counts {
  return {
    active: mainRows.filter((row) => row.selection === "active").length,
    off: mainRows.filter((row) => row.selection === "off").length,
    archive: archivedRows.length,
    total: mainRows.length + archivedRows.length,
  };
}

type GlobalPayloadOptions = {
  showCatalog?: boolean;
  customUpdatesChecked?: boolean;
  customUpdatable?: GlobalPayload["customUpdatable"];
};

export function globalPayload(
  lock: Lock,
  message = "",
  options: GlobalPayloadOptions = {}
): GlobalPayload {
  const decks = deckNames();

  // catalog 表示は tristate ではなく「全 skill のカタログ」を返す別形。
  if (options.showCatalog) {
    return {
      page: "global",
      title: "Global skills",
      message,
      decks,
      showCatalog: true,
      rows: skillRows(lock, undefined, allSkillNames(lock)),
      archivedRows: [],
      counts: null,
      customUpdatesChecked: false,
      customUpdatable: [],
      presets: listUserPresets(),
      hasPreviousPreset: hasPreviousPreset(),
      hasManagedActive: managedActiveSkills(lock).size > 0,
    };
  }

  const [mainRows, archivedRows] = globalTristateRows(lock);
  return {
    page: "global",
    title: "Global skills",
    message,
    decks,
    showCatalog: false,
    rows: mainRows,
    archivedRows,
    counts: countsDict(mainRows, archivedRows),
    customUpdatesChecked: options.customUpdatesChecked ?? false,
    customUpdatable: options.customUpdatable ?? [],
    presets: listUserPresets(),
    hasPreviousPreset: hasPreviousPreset(),
    hasManagedActive: managedActiveSkills(lock).size > 0,
  };
}

// ---- 外部 source（#70 で移植）----

/**
 * source 一覧。更新確認は済んでいるものだけ `checked` が立ち、バッジもそこから決まる。
 * 一覧を開くだけで GitHub を叩かないのは意図的で、確認は明示操作に限る。
 */
export function externalSourcesPayload(
  lock: Lock,
  message = "",
  updateStatusBySource: Record<string, SourceUpdateStatus> = {}
): ExternalSourcesPayload {
  const rows = externalSourceSummary(lock).map((row) => {
    const status = updateStatusBySource[row.source];
    return {
      ...row,
      statusLabel: externalSourceStatusLabel(status),
      updatable: [...(status?.updatable ?? [])],
      checked: Boolean(status?.checked),
      error: status?.error ?? null,
    };
  });
  return {
    page: "external-sources",
    title: "External sources",
    message,
    decks: deckNames(),
    sources: rows,
    totalUpdatable: rows.reduce(
      (total, row) => total + (row.checked ? row.updatable.length : 0),
      0
    ),
    updateStatusBySource,
  };
}

/**
 * source 1 件の詳細。install 済みと未 install を分けて返す。
 *
 * lock には居るのに候補一覧に出てこない skill（upstream から消えた等）も、
 * lock 側の情報だけで install 済みとして出す。ここで落とすと管理から外す導線も消える。
 */
export async function externalSourceDetailPayload(
  lock: Lock,
  source: string,
  candidates: ExternalCandidate[],
  message = ""
): Promise<ExternalSourceDetailPayload> {
  const ownerRepo = normalizeGithubSource(source);
  const installed = Object.fromEntries(
    Object.entries(lock.external ?? {}).filter(
      ([, meta]) => meta.source === ownerRepo
    )
  );

  const candidateByName = new Map<string, ExternalCandidate>(
    candidates.map((candidate) => [candidate.name, candidate])
  );
  for (const [name, meta] of Object.entries(installed)) {
    if (!candidateByName.has(name)) {
      candidateByName.set(name, {
        name,
        description: skillDescription(lock, name),
        path: meta.skillPath ?? "",
      });
    }
  }

  const installedSkills: InstalledExternal[] = [];
  const availableRows: SkillRow[] = [];
  const updatableSkills: string[] = [];
  const activeExternal = activeExternalSkillNames(lock);
  const archivedExternal = new Set(
    [...visibleInstalledNames(lock, archiveDir())].filter(
      (name) => name in installed
    )
  );

  for (const name of sortNames(candidateByName.keys())) {
    const candidate = candidateByName.get(name) as ExternalCandidate;
    // active でないものは更新確認しない。update しても projection に出ないため。
    const hasUpdate =
      activeExternal.has(name) && (await skillHasRemoteUpdate(name, candidate));
    if (hasUpdate) updatableSkills.push(name);

    if (name in installed) {
      installedSkills.push({
        name,
        description: candidate.description ?? "",
        path: candidate.path ?? "",
        state: skillProjectionState(name, activeExternal, archivedExternal),
        hasUpdate,
        updateCommand: hasUpdate
          ? shellCommandText(externalUpdateCommand(name))
          : "",
        managed: true,
      });
      continue;
    }

    availableRows.push({
      name,
      category: candidate.path || ownerRepo,
      description: candidate.description ?? "",
      source: "external",
      state: "missing",
      checked: false,
    });
  }

  return {
    page: "external-source-detail",
    title: ownerRepo,
    message,
    decks: deckNames(),
    source: ownerRepo,
    installed: installedSkills,
    available: availableRows,
    updatable: updatableSkills,
  };
}

// ---- draft（#72 で移植）----

/**
 * draft 一覧。`confirmSelected` が空でなければ、フロントは「既に正式登録済み」の
 * 確認パネルを出して force 付きで押し直させる。
 */
export function draftsPayload(
  lock: Lock,
  message = "",
  confirmSelected: string[] = []
): DraftsPayload {
  const rows = draftRows(lock);
  const draftCount = rows.filter((row) => row.state === "draft").length;
  return {
    page: "drafts",
    title: `Draft skills · draft ${draftCount} · total ${rows.length}`,
    message,
    decks: deckNames(),
    rows,
    confirmSelected: sortNames(confirmSelected),
  };
}

// ---- project deck（#73 で移植）----

/**
 * deck 1 枚の payload。
 *
 * カタログ表示のときだけ全 skill を並べ、それ以外は deck の skill だけを出す。
 * 既定でチェックが付くのは「deck に居て、かつ今 active なもの」に限る。
 * deck に居るだけでチェックを付けると、まだ入れていない skill が入っているように見える。
 */
export function projectDeckPayload(
  lock: Lock,
  deckName: string,
  message = "",
  options: { showCatalog?: boolean } = {}
): ProjectDeckPayload {
  const showCatalog = options.showCatalog ?? false;
  const [, skills] = loadDeck(deckName, new Set(), true);
  const skillSet = new Set(skills);
  const rows = showCatalog
    ? skillRows(lock, skillSet, allSkillNames(lock))
    : skillRows(
        lock,
        new Set(
          [...skillSet].filter((name) =>
            visibleInstalledNames(lock, activeDir()).has(name)
          )
        ),
        skillSet
      );
  return {
    page: "project-deck",
    title: `${capitalize(deckName)} deck`,
    message,
    decks: deckNames(),
    deckName,
    showCatalog,
    rows,
    installCommands: projectDeckInstallCommands(lock, skills),
    skillNames: sortNames(skillSet),
  };
}

/**
 * 取り込み前の確認画面。source の候補を、手元の projection 状態と突き合わせて出す。
 *
 * `category` 欄には候補のリポジトリ内パスを載せる（同名 skill が複数階層にある source で、
 * どれを取るのか区別できないため）。パスの分からない候補は source 名で代用する。
 */
export function externalPreviewPayload(
  lock: Lock,
  deckName: string,
  source: string,
  candidates: ExternalCandidate[],
  message = ""
): ExternalPreviewPayload {
  const ownerRepo = normalizeGithubSource(source);
  const active = visibleInstalledNames(lock, activeDir());
  const archived = visibleInstalledNames(lock, archiveDir());
  return {
    page: "external-preview",
    title: `外部skillsを取り込む - ${ownerRepo}`,
    message,
    decks: deckNames(),
    deckName,
    source: ownerRepo,
    rows: candidates.map((candidate) => ({
      name: candidate.name,
      category: candidate.path ?? ownerRepo,
      description: candidate.description ?? "",
      source: "external",
      state: active.has(candidate.name)
        ? "active"
        : archived.has(candidate.name)
          ? "archive"
          : "missing",
      checked: false,
    })),
  };
}

/** Python の `str.capitalize()`。先頭だけ大文字にして、残りは小文字に潰す。 */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
