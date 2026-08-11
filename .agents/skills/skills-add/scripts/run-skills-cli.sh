#!/bin/bash
# Run the `skills` CLI, falling back from bunx to npx when bunx is broken.

skills_cli() {
    local subcommand="$1"
    shift
    local bin="${MY_SKILLS_ADD_BIN:-${MY_SKILLS_UPDATE_BIN:-bunx}}"
    "$bin" skills "$subcommand" "$@"
    local ec=$?
    if [ "$ec" -eq 0 ]; then
        return 0
    fi
    if [ "$bin" = "bunx" ] && command -v npx >/dev/null 2>&1; then
        echo "Warning: bunx skills $subcommand failed (exit $ec); retrying with npx" >&2
        npx skills "$subcommand" "$@"
        return $?
    fi
    return "$ec"
}
