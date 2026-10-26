#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: restore.sh snapshot-ID NEW_RECOVERY_DIRECTORY_NAME' >&2
  exit 2
fi
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec docker compose --env-file .env -f compose.yaml run --rm --no-deps restore "$1" "$2"
