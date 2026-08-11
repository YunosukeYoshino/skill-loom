resolve_catalog_root() {
  local selected="${1:-${MY_SKILLS_CATALOG_DIR:-}}"
  if [ -z "$selected" ]; then
    selected="$(git rev-parse --show-toplevel)"
  fi
  [ -d "$selected" ] || { echo "Error: Catalog directory not found: $selected" >&2; return 1; }
  (cd "$selected" && pwd -P)
}
