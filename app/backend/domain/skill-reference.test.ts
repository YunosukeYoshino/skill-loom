import { expect, test } from "bun:test";
import { checkedSkillRef } from "./skill-reference";

test("skill references share canonical source and safe source paths", () => {
  expect(
    checkedSkillRef({
      name: "alpha",
      source: "Owner/Repo",
      skillPath: "skills/alpha/SKILL.md",
    })
  ).toEqual({
    name: "alpha",
    source: "owner/repo",
    skillPath: "skills/alpha/SKILL.md",
  });
  expect(checkedSkillRef({ name: "alpha" })).toEqual({ name: "alpha" });
});

test.each(
  [
    null,
    [],
    {},
    { name: 1 },
    { name: "../alpha" },
    { name: "alpha", source: 1 },
    { name: "alpha", source: "https://github.com/owner/repo" },
    { name: "alpha", source: `owner/${"x".repeat(201)}` },
  ].map((ref) => ({ ref }))
)("invalid skill reference is rejected: %j", ({ ref }) => {
  expect(() => checkedSkillRef(ref)).toThrow();
});

test.each([
  1,
  "",
  "/SKILL.md",
  "../SKILL.md",
  "./SKILL.md",
  "skills//SKILL.md",
  "skills/.GiT/SKILL.md",
  "skills\\SKILL.md",
  "skills\n/SKILL.md",
  "C:/SKILL.md",
  "README.md",
  "NOTSKILL.md",
])("unsafe source path is rejected: %j", (skillPath) => {
  expect(() => checkedSkillRef({ name: "alpha", skillPath })).toThrow();
});
