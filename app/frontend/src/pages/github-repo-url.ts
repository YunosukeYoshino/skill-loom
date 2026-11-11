const GITHUB_OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/** Normalized `owner/repo` only. Anything else stays a non-link. */
export function githubRepoUrl(source: string): string | null {
  if (!GITHUB_OWNER_REPO.test(source)) return null;
  return `https://github.com/${source}`;
}
