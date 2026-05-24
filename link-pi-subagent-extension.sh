#!/usr/bin/env bash
set -euo pipefail

# Toggle this checkout between:
#   - project-local extension + project override that hides the global package
#   - global package only
#
# Run this script from the package/repository root (the directory containing index.ts).
#
# Pi discovers project-local extensions from:
#   .pi/extensions/*/index.ts
#
# The project-local extension link points back to this repository root:
#   .pi/extensions/pi-subagent -> ../..
#
# The global pi-subagent package is installed as:
#   git:https://github.com/Sanming-BW/pi-subagent
#
# This script keeps only one active at a time so tool/flag name conflicts do not occur.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$ROOT_DIR"
EXTENSIONS_DIR="$ROOT_DIR/.pi/extensions"
LINK_PATH="$EXTENSIONS_DIR/pi-subagent"
PROJECT_SETTINGS_FILE="$ROOT_DIR/.pi/settings.json"
REL_TARGET="../.."
GLOBAL_PACKAGE_SOURCE="${PI_SUBAGENT_GLOBAL_SOURCE:-git:https://github.com/Sanming-BW/pi-subagent}"

usage() {
  cat <<'EOF'
Usage: ./link-pi-subagent-extension.sh <link|unlink|toggle|status>

Commands:
  link      Enable project-local mode:
            - create .pi/extensions/pi-subagent -> ../..
            - add a project override for the global pi-subagent package
  unlink    Disable project-local mode and fall back to global package
  toggle    Switch between project-local and global mode
  status    Show current mode and any partial state

After switching, run /reload in pi or restart pi.
EOF
}

ensure_source() {
  if [[ ! -f "$SOURCE_DIR/index.ts" ]]; then
    echo "Error: expected extension entry not found: $SOURCE_DIR/index.ts" >&2
    exit 1
  fi
}

is_our_link() {
  [[ -L "$LINK_PATH" && "$(readlink "$LINK_PATH")" == "$REL_TARGET" ]]
}

project_package_present() {
  PROJECT_SETTINGS_FILE="$PROJECT_SETTINGS_FILE" \
  GLOBAL_PACKAGE_SOURCE="$GLOBAL_PACKAGE_SOURCE" \
  node <<'EOF'
const fs = require('node:fs');
const settingsPath = process.env.PROJECT_SETTINGS_FILE;
const source = process.env.GLOBAL_PACKAGE_SOURCE;

try {
  if (!fs.existsSync(settingsPath)) process.exit(3);
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  if (!raw) process.exit(3);

  const settings = JSON.parse(raw);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const present = packages.some((entry) => {
    if (typeof entry === 'string') return entry === source;
    return !!entry && typeof entry === 'object' && entry.source === source;
  });

  process.exit(present ? 0 : 3);
} catch (error) {
  console.error(`Error: failed to inspect ${settingsPath}: ${error.message}`);
  process.exit(1);
}
EOF
}

write_project_settings() {
  local action="$1"
  PROJECT_SETTINGS_FILE="$PROJECT_SETTINGS_FILE" \
  GLOBAL_PACKAGE_SOURCE="$GLOBAL_PACKAGE_SOURCE" \
  ACTION="$action" \
  node <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const settingsPath = process.env.PROJECT_SETTINGS_FILE;
const source = process.env.GLOBAL_PACKAGE_SOURCE;
const action = process.env.ACTION;

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed;
      }
    } catch (error) {
      console.error(`Error: failed to parse ${settingsPath}: ${error.message}`);
      process.exit(1);
    }
  }
}

const packages = Array.isArray(settings.packages) ? settings.packages : [];
const sameSource = (entry) => {
  if (typeof entry === 'string') return entry === source;
  return !!entry && typeof entry === 'object' && entry.source === source;
};

if (action === 'enable') {
  let replaced = false;
  const next = [];
  for (const entry of packages) {
    if (!sameSource(entry)) {
      next.push(entry);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    if (typeof entry === 'string') {
      next.push({ source, extensions: [] });
    } else {
      next.push({ ...entry, extensions: [] });
    }
  }
  if (!replaced) next.push({ source, extensions: [] });
  settings.packages = next;
} else if (action === 'disable') {
  const next = packages.filter((entry) => !sameSource(entry));
  if (next.length > 0) settings.packages = next;
  else delete settings.packages;
} else {
  console.error(`Error: unknown settings action: ${action}`);
  process.exit(2);
}

if (Object.keys(settings).length === 0) {
  if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
  process.exit(0);
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
EOF
}

enable_project_mode() {
  ensure_source
  mkdir -p "$EXTENSIONS_DIR"
  write_project_settings enable

  if is_our_link; then
    echo "Already enabled: $LINK_PATH -> $REL_TARGET"
  else
    if [[ -e "$LINK_PATH" || -L "$LINK_PATH" ]]; then
      echo "Error: $LINK_PATH already exists and is not this script's link." >&2
      echo "Refusing to overwrite. Current status:" >&2
      print_status >&2 || true
      exit 1
    fi

    ln -s "$REL_TARGET" "$LINK_PATH"
    echo "Enabled: $LINK_PATH -> $REL_TARGET"
  fi

  echo "Project override written to: $PROJECT_SETTINGS_FILE"
  echo "Run /reload in pi or restart pi to load project-local mode."
}

disable_project_mode() {
  if is_our_link; then
    rm "$LINK_PATH"
    echo "Removed: $LINK_PATH"
  elif [[ -L "$LINK_PATH" || -e "$LINK_PATH" ]]; then
    echo "Error: refusing to remove a path not created by this script." >&2
    print_status >&2 || true
    exit 1
  else
    echo "No project-local link to remove."
  fi

  write_project_settings disable
  echo "Project override removed from: $PROJECT_SETTINGS_FILE"
  echo "Run /reload in pi or restart pi to fall back to the global package."
}

print_status() {
  local link_state filter_state

  if is_our_link; then
    link_state="linked"
  elif [[ -L "$LINK_PATH" ]]; then
    link_state="different symlink: $(readlink "$LINK_PATH")"
  elif [[ -e "$LINK_PATH" ]]; then
    link_state="blocked by existing path"
  else
    link_state="missing"
  fi

  filter_state="absent"
  if project_package_present; then
    filter_state="present"
  else
    case $? in
      3) filter_state="absent" ;;
      *) exit $? ;;
    esac
  fi

  if [[ "$link_state" == "linked" && "$filter_state" == "present" ]]; then
    echo "project: local extension linked + global package overridden"
  elif [[ "$link_state" == "missing" && "$filter_state" == "absent" ]]; then
    echo "global: using the globally installed pi-subagent"
  else
    echo "partial: link=$link_state, project-override=$filter_state"
    return 1
  fi
}

cmd="${1:-status}"
case "$cmd" in
  link|on|enable)
    enable_project_mode
    ;;
  unlink|off|disable|remove)
    disable_project_mode
    ;;
  toggle)
    if is_our_link && project_package_present; then
      disable_project_mode
    else
      enable_project_mode
    fi
    ;;
  status)
    print_status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
