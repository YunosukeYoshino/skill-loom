import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button, Message, WorkbenchShell } from "@/components/ui";
import { useUiSettings } from "@/settings/react";
import type { ProjectPreview } from "@shared/project-types";

// fallow-ignore-next-line complexity
export function ProjectsPage() {
  const qc = useQueryClient();
  const { settings } = useUiSettings();
  const l = (ja: string, en: string) => (settings.locale === "ja" ? ja : en);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [deck, setDeck] = useState("");
  const [skill, setSkill] = useState("");
  const [force, setForce] = useState(false);
  const [review, setReview] = useState<ProjectPreview | null>(null);
  const [imported, setImported] = useState("");
  const list = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const status = useQuery({
    queryKey: ["project", selected],
    queryFn: () => api.project(selected),
    enabled: !!selected,
  });
  const registration = useMutation({
    mutationFn: () => api.registerProject(name, path, deck || undefined),
    onSuccess: (p) => {
      setSelected(p.name);
      setName("");
      setPath("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const change = useMutation({
    mutationFn: ({
      action,
      skill,
      revision,
    }: {
      action: "install" | "update" | "remove" | "sync" | "preview";
      skill?: string;
      revision?: string;
    }) =>
      action === "sync" || action === "preview"
        ? api.syncProject(selected, force, action === "preview", revision)
        : api.projectSkill(
            selected,
            skill!,
            action,
            Boolean(revision),
            revision
          ),
    onSuccess: (data) => {
      setReview(null);
      qc.setQueryData(["project", selected], data);
    },
  });
  const preview = useMutation({
    mutationFn: (skill: string) => api.projectSkillPreview(selected, skill),
    onSuccess: setReview,
  });
  const unregister = useMutation({
    mutationFn: () => api.unregisterProject(selected),
    onSuccess: () => {
      setSelected("");
      setReview(null);
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const importSkill = useMutation({
    mutationFn: (skill: string) => api.importProjectSkill(selected, skill),
    onSuccess: (data) => {
      setImported(
        `${data.importedDraft.name}: ${l("Draft に取り込みました。Drafts で確認して昇格してください。", "Imported as a Draft. Review and promote it in Drafts.")}${data.message}`
      );
      qc.setQueryData(["project", selected], data);
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
  const error =
    registration.error ||
    change.error ||
    preview.error ||
    importSkill.error ||
    unregister.error ||
    list.error ||
    status.error;
  const busy =
    change.isPending ||
    registration.isPending ||
    preview.isPending ||
    importSkill.isPending;
  return (
    <WorkbenchShell
      title={l("プロジェクト", "Projects")}
      current="projects"
      decks={list.data?.decks ?? []}
    >
      <p className="mb-4 text-sm">
        {l(
          "リポジトリのスキルを閲覧・管理します。グローバルの状態は変更しません。",
          "Browse and manage repository skills without changing global state."
        )}
      </p>
      <Message text={error instanceof Error ? error.message : ""} />
      <Message text={imported} />
      <form
        className="mb-5 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          registration.mutate();
        }}
      >
        <input
          aria-label={l("名前", "Name")}
          placeholder={l("名前", "Name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          pattern="[a-z0-9][a-z0-9-]*"
          className="rounded border p-2"
        />
        <input
          aria-label={l("絶対パス", "Absolute path")}
          placeholder="/path/to/repository"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          required
          className="min-w-64 rounded border p-2"
        />
        <select
          aria-label={l("任意のデッキ", "Optional deck")}
          value={deck}
          onChange={(e) => setDeck(e.target.value)}
          className="rounded border p-2"
        >
          <option value="">{l("デッキなし", "No deck")}</option>
          {list.data?.decks.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <Button type="submit" disabled={busy}>
          {l("登録", "Register")}
        </Button>
      </form>
      <div className="mb-5 flex flex-wrap gap-2">
        {list.data?.projects.map((p) => (
          <Button
            key={p.name}
            onClick={() => {
              setSelected(p.name);
              setReview(null);
              setImported("");
              change.reset();
            }}
            aria-pressed={selected === p.name}
          >
            {p.name}
          </Button>
        ))}
      </div>
      {list.isPending ? (
        <p>{l("読み込み中…", "Loading…")}</p>
      ) : !list.data?.projects.length ? (
        <p>{l("プロジェクトは未登録です。", "No projects registered.")}</p>
      ) : null}
      {selected && status.isPending ? (
        <p>{l("読み込み中…", "Loading…")}</p>
      ) : null}
      {status.data ? (
        <section>
          <h2 className="text-lg font-semibold">{status.data.project.name}</h2>
          <p className="mb-3 break-all text-sm">{status.data.project.path}</p>
          <Button
            disabled={busy || unregister.isPending}
            onClick={() => unregister.mutate()}
          >
            {l("登録解除（ファイルは保持）", "Unregister (keep files)")}
          </Button>
          {status.data.state === "missing" ? (
            <p role="alert" className="mt-3">
              {l(
                "プロジェクトのパスが見つかりません。登録解除のみ可能です。",
                "Project directory is missing. Only unregister is available."
              )}
            </p>
          ) : (
            <>
              <p className="my-3 text-sm">
                {l(
                  "変更はリポジトリの diff に現れます。自動コミットは行いません。",
                  "Changes appear in this repository's diff. Nothing is committed automatically."
                )}
              </p>
              {status.data.dirty ? (
                <p role="alert" className="mb-3 text-sm">
                  {l(
                    "スキル関連パスに未コミットの変更があります。",
                    "Skill paths have uncommitted changes."
                  )}
                </p>
              ) : null}
              <label className="mb-3 block text-sm">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                />{" "}
                {l(
                  "ローカル変更を上書き（force）",
                  "Overwrite local drift (force)"
                )}
              </label>
              <form
                className="mb-4 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  change.mutate({ action: "install", skill });
                }}
              >
                <select
                  aria-label={l("Inventory スキル", "Inventory skill")}
                  value={skill}
                  onChange={(e) => setSkill(e.target.value)}
                  required
                  className="rounded border p-2"
                >
                  <option value="">
                    {l("スキルを選択", "Select a skill")}
                  </option>
                  {list.data?.inventory.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <Button type="submit" disabled={busy || !skill}>
                  {l("インストール", "Install")}
                </Button>
              </form>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        l("スキル", "Skill"),
                        l("説明", "Description"),
                        l("状態", "Status"),
                        l("グローバル Active", "Global Active"),
                        l("操作", "Actions"),
                      ].map((h) => (
                        <th className="p-2" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {status.data.skills.map(
                      // fallow-ignore-next-line complexity
                      (s) => (
                        <tr key={s.name} className="border-t">
                          <td className="p-2">
                            {s.displayName}
                            <div className="text-xs">{s.name}</div>
                            <div className="text-xs">
                              {s.locations.join(", ")}
                            </div>
                            {s.importError ? (
                              <p className="text-xs text-red-600">
                                {s.importError}
                              </p>
                            ) : null}
                          </td>
                          <td className="p-2">{s.description}</td>
                          <td className="p-2">
                            {s.state}
                            <div className="max-w-40 break-all text-xs">
                              {s.sourceVersion}
                            </div>
                          </td>
                          <td className="p-2">
                            {s.globalActive ? (
                              <span>
                                {l(
                                  "グローバルとプロジェクトの両方に存在。Claude Code は personal が優先。Codex は両方を表示する場合があります。",
                                  "Both global and project. Claude Code: personal wins. Codex may list both."
                                )}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="p-2">
                            <div className="flex gap-2">
                              <Button
                                disabled={
                                  busy || !s.available || !s.locations.length
                                }
                                onClick={() => preview.mutate(s.name)}
                              >
                                {l(
                                  "更新差分・管理に追加",
                                  "Review update / adopt"
                                )}
                              </Button>
                              {!s.inventory ? (
                                <Button
                                  disabled={busy || !s.importable}
                                  onClick={() => importSkill.mutate(s.name)}
                                >
                                  {l("Draft に取り込む", "Import as Draft")}
                                </Button>
                              ) : null}
                              <Button
                                disabled={busy || !s.locations.length}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      l(
                                        `${s.name} を削除しますか？コミットすると全員のリポジトリから削除されます。`,
                                        `Remove ${s.name}? Once committed, this removes the skill for everyone using this repository.`
                                      )
                                    )
                                  )
                                    change.mutate({
                                      action: "remove",
                                      skill: s.name,
                                    });
                                }}
                              >
                                {l("削除", "Remove")}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
              {!status.data.skills.length ? (
                <p>{l("スキルはありません。", "No project skills.")}</p>
              ) : null}
              {review ? (
                <section
                  className="my-4 rounded border p-3"
                  aria-label={l("更新差分", "Update diff")}
                >
                  <h3>{review.skill}</h3>
                  <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">
                    {review.diff}
                  </pre>
                  <p>
                    {l(
                      "確認するとローカルの内容を Inventory の内容で置き換えます。",
                      "Confirming replaces local content with the Inventory source."
                    )}
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      change.mutate({
                        action: "update",
                        skill: review.skill,
                        revision: review.revision,
                      })
                    }
                  >
                    {l("差分を確認して更新", "Confirm reviewed update")}
                  </Button>
                  <Button onClick={() => setReview(null)}>
                    {l("キャンセル", "Cancel")}
                  </Button>
                </section>
              ) : null}
              {status.data.project.deck ? (
                <section className="mt-6 border-t pt-3">
                  <h3>
                    {l("追加操作: デッキ同期", "Optional: deck sync")} ·{" "}
                    {status.data.project.deck}
                  </h3>
                  {status.data.deckError ? (
                    <p role="alert">{status.data.deckError}</p>
                  ) : null}
                  <Button
                    disabled={busy || Boolean(status.data.deckError)}
                    onClick={() => change.mutate({ action: "preview" })}
                  >
                    {l("同期プレビュー", "Preview sync")}
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      Boolean(status.data.deckError) ||
                      (force &&
                        status.data.skills.some((s) => s.state === "drifted") &&
                        !status.data.review)
                    }
                    onClick={() =>
                      change.mutate({
                        action: "sync",
                        revision: status.data?.review?.revision,
                      })
                    }
                  >
                    {force
                      ? l(
                          "差分を確認して強制同期",
                          "Confirm reviewed force sync"
                        )
                      : l("デッキ同期", "Sync deck")}
                  </Button>
                </section>
              ) : null}
              {status.data.review ? (
                <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">
                  {status.data.review.diff}
                </pre>
              ) : null}
              {status.data.plan.length ? (
                <details className="mt-4" open>
                  <summary>{l("デッキ同期計画", "Deck sync plan")}</summary>
                  <ul>
                    {status.data.plan.map((c) => (
                      <li key={c.name}>
                        {c.name}: {c.action} {c.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="mt-4 text-xs">
                <a href="https://code.claude.com/docs/en/skills#run-a-same-named-skill-from-an-added-directory">
                  Claude Code docs
                </a>{" "}
                ·{" "}
                <a href="https://developers.openai.com/codex/skills/">
                  Codex docs
                </a>
              </p>
            </>
          )}
        </section>
      ) : null}
    </WorkbenchShell>
  );
}
