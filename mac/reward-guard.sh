#!/bin/bash
# reward-guard.sh - Reward Vault enforcement agent for macOS.
#
# Polls the Reward Vault API. While NO reward timer is active, it kills any process whose
# executable path is under a configured game folder (blockPaths) or whose name is in
# blockProcessNames, unless spared by allowPaths / allowProcessNames. Any active timer
# (handheld / grinder / raid) unlocks everything. Only games are killed - the network is
# never touched.
#
# Before a running timer expires it shows a warning (default 10 and 5 min left) offering to
# add time (spend a vaulted reward) or open the dashboard.
#
# No external deps: uses curl + /usr/bin/osascript (JavaScript) for JSON, both built in.
# Runs as a per-user LaunchAgent. Install via install-reward-guard.sh.

set -u

SUPPORT_DIR="$HOME/Library/Application Support/RewardGuard"
LOG="$SUPPORT_DIR/reward-guard.log"
CONFIG="${REWARD_GUARD_CONFIG:-$SUPPORT_DIR/reward-guard.config.json}"
mkdir -p "$SUPPORT_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG" 2>/dev/null; }

if [ ! -f "$CONFIG" ]; then log "config not found: $CONFIG"; exit 1; fi
CONFIG_JSON="$(cat "$CONFIG")"

# ---- JSON helpers (JavaScript for Automation; always present on macOS) ----
# js_eval <json> <expr-using-s>   -> evaluates a JS expression where s = parsed JSON
js_eval() { /usr/bin/osascript -l JavaScript -e 'function run(a){try{var s=JSON.parse(a[0]);return String('"$2"')}catch(e){return ""}}' "$1" 2>/dev/null; }
# cfg_scalar <key> ; cfg_array <key> (newline-joined)
cfg_scalar() { js_eval "$CONFIG_JSON" "(s.$1===undefined?'':s.$1)"; }
cfg_array()  { js_eval "$CONFIG_JSON" "(s.$1||[]).join('\n')"; }

expand_tilde() { case "$1" in "~/"*) printf '%s' "$HOME/${1#~/}";; "~") printf '%s' "$HOME";; *) printf '%s' "$1";; esac; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

POLL="$(cfg_scalar pollSeconds)"; [ -z "$POLL" ] && POLL=5
WARN_TIMEOUT="$(cfg_scalar warnTimeoutSeconds)"; [ -z "$WARN_TIMEOUT" ] && WARN_TIMEOUT=120
BLOCK_WHEN_UNREACHABLE="$(cfg_scalar blockWhenUnreachable)"
HOSTNAME_NICE="$(scutil --get ComputerName 2>/dev/null || hostname)"

# Materialize path/name lists (lowercased) into files so entries with spaces are safe.
BLOCK_PATHS_F="$SUPPORT_DIR/.blockpaths"; ALLOW_PATHS_F="$SUPPORT_DIR/.allowpaths"
BLOCK_NAMES_F="$SUPPORT_DIR/.blocknames"; ALLOW_NAMES_F="$SUPPORT_DIR/.allownames"
: > "$BLOCK_PATHS_F"; : > "$ALLOW_PATHS_F"; : > "$BLOCK_NAMES_F"; : > "$ALLOW_NAMES_F"
while IFS= read -r p; do [ -n "$p" ] && lc "$(expand_tilde "$p")" >> "$BLOCK_PATHS_F"; done <<EOF
$(cfg_array blockPaths)
EOF
while IFS= read -r p; do [ -n "$p" ] && lc "$(expand_tilde "$p")" >> "$ALLOW_PATHS_F"; done <<EOF
$(cfg_array allowPaths)
EOF
while IFS= read -r p; do [ -n "$p" ] && lc "$p" >> "$BLOCK_NAMES_F"; done <<EOF
$(cfg_array blockProcessNames)
EOF
while IFS= read -r p; do [ -n "$p" ] && lc "$p" >> "$ALLOW_NAMES_F"; done <<EOF
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
  --data "{\"host\":\"$HOSTNAME_NICE\",\"locked\":$1,\"version\":\"mac-1\"}" >/dev/null 2>&1; }
now_ms() { echo $(( $(date +%s) * 1000 )); }

# ---- prefix match against a file of lowercased path prefixes ----
under_any() { # $1 = lowercased path, $2 = file
  local target="$1" line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$target" in "$line"/*) return 0;; esac
  done < "$2"
  return 1
}
in_list() { # $1 = lowercased name, $2 = file
  local n="$1" line
  while IFS= read -r line; do [ "$n" = "$line" ] && return 0; done < "$2"
  return 1
}

enforce() {
  local pid path name lcpath lcname killed=""
  # comm= gives the full executable path on macOS (incl. the binary inside .app bundles).
  # read with default IFS: first field = pid, remainder = path (embedded spaces preserved).
  while read -r pid path; do
    [ -z "$pid" ] && continue
    [ -z "$path" ] && continue
    name="${path##*/}"
    lcpath="$(lc "$path")"; lcname="$(lc "$name")"
    case "$lcpath" in /system/*|/usr/*|/applications/steam.app/*) continue;; esac
    in_list "$lcname" "$ALLOW_NAMES_F" && continue
    under_any "$lcpath" "$ALLOW_PATHS_F" && continue
    if in_list "$lcname" "$BLOCK_NAMES_F" || under_any "$lcpath" "$BLOCK_PATHS_F"; then
      kill -9 "$pid" 2>/dev/null && killed="$killed $name"
    fi
  done <<EOF
$(ps -axo pid=,comm=)
EOF
  [ -n "$killed" ] && log "killed:$killed"
}

# ---- warning dialog (spawned in background so the loop keeps enforcing) ----
show_warning() {
  local remain="$1" base="$2"
  (
    /usr/bin/osascript -e "display notification \"About $remain minutes of game time left.\" with title \"Reward Vault\"" 2>/dev/null
    local choice
    choice="$(/usr/bin/osascript -e "button returned of (display dialog \"About $remain minutes of game time left.\nAdd more time, or it locks when the timer ends.\" buttons {\"Open Dashboard\",\"Add Time\",\"Dismiss\"} default button \"Add Time\" with title \"Reward Vault\" giving up after $WARN_TIMEOUT)" 2>/dev/null)"
    case "$choice" in
      "Open Dashboard") /usr/bin/open "$base" ;;
      "Add Time")
        local st rewards pick rid
        st="$(curl -fsS -m 6 "$base/api/state" 2>/dev/null)"
        # build "label\tid" lines for rewards with stock > 0
        rewards="$(/usr/bin/osascript -l JavaScript -e 'function run(a){var s=JSON.parse(a[0]);var o=[];(s.rewards||[]).forEach(function(r){var st=(s.stacks||{})[r.id]||0;if(st>0){var m=r.editable?s.raidDuration:r.defaultMins;o.push("+"+m+" min  "+r.name+"  ("+st+" left)\t"+r.id)}});return o.join("\n")}' "$st" 2>/dev/null)"
        if [ -z "$rewards" ]; then
          /usr/bin/osascript -e 'display notification "Vault is empty - open the dashboard to buy." with title "Reward Vault"' 2>/dev/null
        else
          local labels; labels="$(printf '%s\n' "$rewards" | sed 's/\t.*//')"
          pick="$(/usr/bin/osascript -e "set L to {$(printf '%s\n' "$labels" | sed 's/.*/"&"/' | paste -sd, -)}" -e "set c to (choose from list L with prompt \"Add which reward?\" with title \"Reward Vault\")" -e "if c is false then return \"\"" -e "return item 1 of c" 2>/dev/null)"
          if [ -n "$pick" ]; then
            rid="$(printf '%s\n' "$rewards" | awk -F'\t' -v p="$pick" '$1==p{print $2; exit}')"
            if [ -n "$rid" ]; then
              if curl -fsS -m 8 -X POST "$base/api/extend" -H 'Content-Type: application/json' --data "{\"rewardId\":\"$rid\"}" >/dev/null 2>&1; then
                /usr/bin/osascript -e 'display notification "Added time." with title "Reward Vault"' 2>/dev/null
              else
                /usr/bin/osascript -e 'display notification "Could not add time." with title "Reward Vault"' 2>/dev/null
              fi
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
      HAS_TIMER="$(js_eval "$STATE" "(s.activeTimer?1:0)")"
      if [ "$HAS_TIMER" = "1" ]; then LOCKED=false; else LOCKED=true; fi
    else
      [ "$BLOCK_WHEN_UNREACHABLE" = "true" ] && LOCKED=true || LOCKED=false
    fi

    [ -n "$API_BASE" ] && heartbeat "$LOCKED"

    if [ -n "$STATE" ] && [ "$(js_eval "$STATE" "(s.activeTimer?1:0)")" = "1" ]; then
      TID="$(js_eval "$STATE" "s.activeTimer.id")"
      if [ "$TID" != "$LAST_TIMER_ID" ]; then LAST_TIMER_ID="$TID"; FIRED=" "; fi
      ENDS="$(js_eval "$STATE" "s.activeTimer.endsAt")"
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
