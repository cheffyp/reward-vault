#!/bin/bash
# reward-guard.sh - Reward Vault enforcement agent for Linux (Bazzite/KDE).
#
# Polls the Reward Vault API. While NO reward timer is active, it kills any process whose
# resolved executable path (/proc/<pid>/exe) is under a configured game folder (blockPaths),
# whose Wine prefix (WINEPREFIX, for Wine/Proton games e.g. via Faugus) is under a
# blockPaths folder, or whose process name (/proc/<pid>/comm) is in blockProcessNames,
# unless spared by allowPaths / allowProcessNames. Any active timer (handheld / grinder /
# raid) unlocks everything. Only games are killed - the network is never touched.
#
# Before a running timer expires it shows a warning (default 10 and 5 min left) offering to
# add time (spend a vaulted reward) or open the dashboard, via kdialog (falls back to
# zenity, then a plain notify-send with no buttons).
#
# Needs: bash, curl, jq. Runs as a per-user systemd --user service. Install via
# install-reward-guard.sh. Only ever touches processes owned by the same user (no sudo).

set -u

SUPPORT_DIR="$HOME/.local/share/RewardGuard"
LOG="$SUPPORT_DIR/reward-guard.log"
CONFIG="${REWARD_GUARD_CONFIG:-$SUPPORT_DIR/reward-guard.config.json}"
mkdir -p "$SUPPORT_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG" 2>/dev/null; }

if [ ! -f "$CONFIG" ]; then log "config not found: $CONFIG"; exit 1; fi
if ! command -v jq >/dev/null 2>&1; then log "jq not found - required for JSON parsing"; exit 1; fi
CONFIG_JSON="$(cat "$CONFIG")"

have() { command -v "$1" >/dev/null 2>&1; }

# ---- JSON helpers (jq) ----
cfg_scalar() { jq -r --arg k "$1" '.[$k] // empty' <<<"$CONFIG_JSON" 2>/dev/null; }
cfg_array()  { jq -r --arg k "$1" '(.[$k] // [])[]' <<<"$CONFIG_JSON" 2>/dev/null; }

# Quote the ~/ in the # pattern: unquoted, bash tilde-expands it and the strip fails.
expand_tilde() { case "$1" in "~/"*) printf '%s' "$HOME/${1#"~/"}";; "~") printf '%s' "$HOME";; *) printf '%s' "$1";; esac; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# Canonicalize symlinks (e.g. Bazzite/ostree's /home -> /var/home) so a configured path
# matches what /proc/<pid>/exe reports, which readlink -f resolves fully. realpath -m
# doesn't require the path to exist yet.
canon_path() { local p; p="$(expand_tilde "$1")"; realpath -m "$p" 2>/dev/null || printf '%s' "$p"; }
# A Wine/Proton game (Faugus, incl. Battle.net and everything it launches) never execs the
# windows .exe directly, so /proc/<pid>/exe just points at the wine binary - but the whole
# process tree for one prefix shares WINEPREFIX, so read that from the environment instead.
wineprefix_of() { tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n 's/^WINEPREFIX=//p' | head -n1; }

POLL="$(cfg_scalar pollSeconds)"; [ -z "$POLL" ] && POLL=5
WARN_TIMEOUT="$(cfg_scalar warnTimeoutSeconds)"; [ -z "$WARN_TIMEOUT" ] && WARN_TIMEOUT=120
BLOCK_WHEN_UNREACHABLE="$(cfg_scalar blockWhenUnreachable)"
HOSTNAME_NICE="$(cfg_scalar deviceName)"; [ -z "$HOSTNAME_NICE" ] && HOSTNAME_NICE="$(hostname)"

# Materialize path/name lists (lowercased) into files so entries with spaces are safe.
BLOCK_PATHS_F="$SUPPORT_DIR/.blockpaths"; ALLOW_PATHS_F="$SUPPORT_DIR/.allowpaths"
BLOCK_NAMES_F="$SUPPORT_DIR/.blocknames"; ALLOW_NAMES_F="$SUPPORT_DIR/.allownames"
: > "$BLOCK_PATHS_F"; : > "$ALLOW_PATHS_F"; : > "$BLOCK_NAMES_F"; : > "$ALLOW_NAMES_F"
while IFS= read -r p; do [ -n "$p" ] && printf '%s\n' "$(lc "$(canon_path "$p")")" >> "$BLOCK_PATHS_F"; done <<EOF
$(cfg_array blockPaths)
EOF
while IFS= read -r p; do [ -n "$p" ] && printf '%s\n' "$(lc "$(canon_path "$p")")" >> "$ALLOW_PATHS_F"; done <<EOF
$(cfg_array allowPaths)
EOF
while IFS= read -r p; do [ -n "$p" ] && printf '%s\n' "$(lc "$p")" >> "$BLOCK_NAMES_F"; done <<EOF
$(cfg_array blockProcessNames)
EOF
while IFS= read -r p; do [ -n "$p" ] && printf '%s\n' "$(lc "$p")" >> "$ALLOW_NAMES_F"; done <<EOF
$(cfg_array allowProcessNames)
EOF

# Thresholds, largest first, as an array (numbers only -> word-splitting is safe).
WARN_THS=( $(cfg_array warnMinutes | sort -rn) )

# ---- API ----
API_BASE=""
resolve_api() {
  local u
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    u="${u%/}"
    if curl -fsS -m 6 "$u/api/state" >/dev/null 2>&1; then API_BASE="$u"; return 0; fi
  done <<EOF
$(cfg_array apiUrls)
EOF
  API_BASE=""; return 1
}
get_state() { curl -fsS -m 6 "$API_BASE/api/state" 2>/dev/null; }
heartbeat() { curl -fsS -m 6 -X POST "$API_BASE/api/guard/heartbeat" -H 'Content-Type: application/json' \
  --data "{\"host\":\"$HOSTNAME_NICE\",\"locked\":$1,\"version\":\"linux-1\"}" >/dev/null 2>&1; }
now_ms() { echo $(( $(date +%s) * 1000 )); }

# ---- prefix match against a file of lowercased path prefixes ----
under_any() { # $1 = lowercased path, $2 = file (matches the prefix itself too, e.g. a WINEPREFIX == the listed folder)
  local target="$1" line
  [ -z "$target" ] && return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$target" in "$line") return 0;; "$line"/*) return 0;; esac
  done < "$2"
  return 1
}
in_list() { # $1 = lowercased name, $2 = file
  local n="$1" line
  while IFS= read -r line; do [ "$n" = "$line" ] && return 0; done < "$2"
  return 1
}

enforce() {
  local pid exe comm lcpath lcname lcwp killed=""
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    exe="$(readlink -f "$d/exe" 2>/dev/null)"
    comm="$(cat "$d/comm" 2>/dev/null)" || continue
    [ -z "$comm" ] && continue
    lcpath="$(lc "$exe")"; lcname="$(lc "$comm")"
    case "$lcpath" in /usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/nix/*) continue;; esac
    in_list "$lcname" "$ALLOW_NAMES_F" && continue
    under_any "$lcpath" "$ALLOW_PATHS_F" && continue
    lcwp="$(lc "$(canon_path "$(wineprefix_of "$pid")")")"
    [ -n "$lcwp" ] && under_any "$lcwp" "$ALLOW_PATHS_F" && continue
    if in_list "$lcname" "$BLOCK_NAMES_F" || under_any "$lcpath" "$BLOCK_PATHS_F" || { [ -n "$lcwp" ] && under_any "$lcwp" "$BLOCK_PATHS_F"; }; then
      kill -9 "$pid" 2>/dev/null && killed="$killed $comm"
    fi
  done
  [ -n "$killed" ] && log "killed:$killed"
}

# ---- warning dialog (spawned in background so the loop keeps enforcing) ----
show_warning() {
  local remain="$1" base="$2"
  (
    have notify-send && notify-send "Reward Vault" "About $remain minutes of game time left." 2>/dev/null
    local choice=""
    if have kdialog; then
      choice="$(timeout "${WARN_TIMEOUT}s" kdialog --title "Reward Vault" \
        --menu "About $remain minutes of game time left.
Add more time, or it locks when the timer ends." \
        dashboard "Open Dashboard" addtime "Add Time" dismiss "Dismiss" 2>/dev/null)"
    elif have zenity; then
      choice="$(timeout "${WARN_TIMEOUT}s" zenity --list --title="Reward Vault" \
        --text="About $remain minutes of game time left.
Add more time, or it locks when the timer ends." \
        --column="id" --column="Action" --hide-column=1 --print-column=1 \
        dashboard "Open Dashboard" addtime "Add Time" dismiss "Dismiss" 2>/dev/null)"
    fi
    case "$choice" in
      dashboard) xdg-open "$base" >/dev/null 2>&1 ;;
      addtime)
        local st rewards rid pick
        local -a args=()
        st="$(curl -fsS -m 6 "$base/api/state" 2>/dev/null)"
        rewards="$(jq -r '
          . as $root
          | ($root.rewards // [])[]
          | . as $r
          | (($root.stacks // {})[$r.id] // 0) as $st
          | select($st > 0)
          | (if $r.editable then $root.raidDuration else $r.defaultMins end) as $m
          | "+\($m) min  \($r.name)  (\($st) left)\t\($r.id)"
        ' <<<"$st" 2>/dev/null)"
        if [ -z "$rewards" ]; then
          have notify-send && notify-send "Reward Vault" "Vault is empty - open the dashboard to buy." 2>/dev/null
        else
          while IFS=$'\t' read -r label rid; do
            [ -z "$rid" ] && continue
            args+=("$rid" "$label")
          done <<EOF
$rewards
EOF
          if have kdialog; then
            pick="$(timeout "${WARN_TIMEOUT}s" kdialog --title "Reward Vault" --menu "Add which reward?" "${args[@]}" 2>/dev/null)"
          elif have zenity; then
            pick="$(timeout "${WARN_TIMEOUT}s" zenity --list --title="Reward Vault" --text="Add which reward?" \
              --column="id" --column="Reward" --hide-column=1 --print-column=1 "${args[@]}" 2>/dev/null)"
          fi
          if [ -n "$pick" ]; then
            if curl -fsS -m 8 -X POST "$base/api/extend" -H 'Content-Type: application/json' --data "{\"rewardId\":\"$pick\"}" >/dev/null 2>&1; then
              have notify-send && notify-send "Reward Vault" "Added time." 2>/dev/null
            else
              have notify-send && notify-send "Reward Vault" "Could not add time." 2>/dev/null
            fi
          fi
        fi
        ;;
    esac
  ) &
}

# ---- main loop ----
log "guard starting (poll ${POLL}s, host $HOSTNAME_NICE)"
LAST_TIMER_ID=""
FIRED=" "        # space-delimited fired thresholds for the current timer
WAS_LOCKED=""

while true; do
  {
    [ -z "$API_BASE" ] && resolve_api
    STATE=""; [ -n "$API_BASE" ] && STATE="$(get_state)"
    [ -z "$STATE" ] && API_BASE=""

    LOCKED=false
    if [ -n "$STATE" ]; then
      HAS_TIMER="$(jq -r 'if .activeTimer then "1" else "0" end' <<<"$STATE" 2>/dev/null)"
      if [ "$HAS_TIMER" = "1" ]; then LOCKED=false; else LOCKED=true; fi
    else
      [ "$BLOCK_WHEN_UNREACHABLE" = "true" ] && LOCKED=true || LOCKED=false
    fi

    [ -n "$API_BASE" ] && heartbeat "$LOCKED"

    if [ -n "$STATE" ] && [ "$(jq -r 'if .activeTimer then "1" else "0" end' <<<"$STATE" 2>/dev/null)" = "1" ]; then
      TID="$(jq -r '.activeTimer.id // empty' <<<"$STATE" 2>/dev/null)"
      if [ "$TID" != "$LAST_TIMER_ID" ]; then LAST_TIMER_ID="$TID"; FIRED=" "; fi
      ENDS="$(jq -r '.activeTimer.endsAt // empty' <<<"$STATE" 2>/dev/null)"
      if [ -n "$ENDS" ]; then
        REMAIN=$(( ( ENDS - $(now_ms) ) / 60000 ))
        n=${#WARN_THS[@]}
        for (( i=0; i<n; i++ )); do
          th=${WARN_THS[$i]}
          # band lower bound = next-smaller threshold (or -1); fire once per band so a
          # mid-timer start does not pop every threshold at once.
          if [ $(( i + 1 )) -lt "$n" ]; then lower=${WARN_THS[$((i+1))]}; else lower=-1; fi
          if [ "$REMAIN" -le "$th" ] && [ "$REMAIN" -gt "$lower" ]; then
            case "$FIRED" in *" $th "*) : ;; *)
              FIRED="$FIRED$th "
              log "warning: ~${REMAIN} min left (threshold $th)"
              show_warning "$REMAIN" "$API_BASE"
            ;; esac
          fi
        done
      fi
    else
      LAST_TIMER_ID=""; FIRED=" "
    fi

    [ "$LOCKED" = "true" ] && enforce

    if [ "$LOCKED" != "$WAS_LOCKED" ]; then
      [ "$LOCKED" = "true" ] && log "state: LOCKED (blocking games)" || log "state: unlocked"
      WAS_LOCKED="$LOCKED"
    fi
  } 2>>"$LOG"
  sleep "$POLL"
done
