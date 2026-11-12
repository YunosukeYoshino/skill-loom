#!/bin/bash
# Run the `skills` CLI, falling back from bunx to npx when bunx is broken.

# Pinned so a republished npm package cannot slip into `-g -y` installs.
# Keep in sync with SKILLS_CLI_PACKAGE in app/backend/domain/config.ts.
SKILLS_CLI_PACKAGE="skills@1.7.6"
# DO_NOT_TRACK=1 stops the CLI's install telemetry and audit lookups to skills.sh.

skills_cli() {
    local subcommand="$1"
    shift
    local bin="${MY_SKILLS_ADD_BIN:-${MY_SKILLS_UPDATE_BIN:-bunx}}"
    DO_NOT_TRACK=1 "$bin" "$SKILLS_CLI_PACKAGE" "$subcommand" "$@"
    local ec=$?
    if [ "$ec" -eq 0 ]; then
        return 0
    fi
    if [ "$bin" = "bunx" ] && command -v npx >/dev/null 2>&1; then
        echo "Warning: bunx skills $subcommand failed (exit $ec); retrying with npx" >&2
        DO_NOT_TRACK=1 npx "$SKILLS_CLI_PACKAGE" "$subcommand" "$@"
        return $?
    fi
    return "$ec"
}
