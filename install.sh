#!/bin/sh
# Installs the omp extensions and the herdr mod by symlinking them from this checkout,
# so `git pull` updates them in place. `--copy` copies instead; `--uninstall` removes them.
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
OMP_EXT="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
HERDR_MODS="${HERDR_MODS_DIR:-$HOME/.config/herdr-app/mods}"
MODE=link
case "${1:-}" in
  --copy) MODE=copy ;;
  --uninstall) MODE=uninstall ;;
  "") ;;
  *) echo "usage: $0 [--copy|--uninstall]" >&2; exit 2 ;;
esac

place() { # src dest
  if [ "$MODE" = uninstall ]; then
    rm -f "$2"
    echo "removed $2"
    return
  fi
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    cp "$2" "$2.bak"
    echo "backed up $2 -> $2.bak"
  fi
  rm -f "$2"
  if [ "$MODE" = copy ]; then cp "$1" "$2"; else ln -s "$1" "$2"; fi
  echo "$MODE $2"
}

mkdir -p "$OMP_EXT" "$HERDR_MODS/agents-stacked"
for f in "$ROOT"/omp/extensions/*.ts; do
  place "$f" "$OMP_EXT/$(basename "$f")"
done
for f in main.js mod.json; do
  place "$ROOT/herdr/mods/agents-stacked/$f" "$HERDR_MODS/agents-stacked/$f"
done

[ "$MODE" = uninstall ] || echo "Done. Restart running omp sessions to load the extensions; herdr reloads the mod on its own."
