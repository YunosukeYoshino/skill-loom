import { expect, test } from "bun:test";
import { githubRepoUrl } from "./github-repo-url";

test("githubRepoUrl links a normalized owner/repo", () => {
  expect(githubRepoUrl("emilkowalski/skills")).toBe(
    "https://github.com/emilkowalski/skills"
  );
  expect(githubRepoUrl("my-org/my.repo")).toBe(
    "https://github.com/my-org/my.repo"
  );
});

test("githubRepoUrl rejects sources that are not a single owner/repo", () => {
  expect(githubRepoUrl("")).toBeNull();
  expect(githubRepoUrl("emilkowalski")).toBeNull();
  expect(githubRepoUrl("https://github.com/emilkowalski/skills")).toBeNull();
  expect(githubRepoUrl("emilkowalski/skills/extra")).toBeNull();
  expect(githubRepoUrl("emilkowalski/skills?tab=readme")).toBeNull();
  expect(githubRepoUrl("javascript:alert(1)")).toBeNull();
});
