#!/usr/bin/env bash
# Backs up VergePay's PostgreSQL database (the public schema, where all the
# app's tables live), keeps the last few days of backups, and can prove a
# backup works by restoring it into a local scratch database.
#
# Usage:
#   scripts/backup-db.sh                  take a backup, then delete ones older than BACKUP_KEEP_DAYS
#   scripts/backup-db.sh --restore-test   restore the newest backup locally and count its rows
#   scripts/backup-db.sh --help
#
# Settings (environment variables, all optional):
#   DATABASE_URI       database to back up; read from the API's .env when not set
#   BACKUP_DIR         where backups and backup.log go   (default: <api>/backups)
#   BACKUP_KEEP_DAYS   delete backups older than this    (default: 7)
#   RESTORE_TEST_DB    scratch database the restore test drops and re-creates
#                      (default: vergepay_restore_test), on the local server
#                      given by the usual PGHOST / PGUSER / PGPASSWORD
#   PG_BIN             folder of the PostgreSQL tools to use, e.g. /usr/lib/postgresql/17/bin
#
# Needs bash, gzip, flock, and pg_dump / psql 17 or newer: Supabase runs
# PostgreSQL 17, and an older pg_dump refuses to dump a newer server.
#
# Every night at 02:00 with cron (crontab -e); it writes its own log:
#   0 2 * * * /path/to/vergePay_api/scripts/backup-db.sh >/dev/null 2>&1

set -Eeuo pipefail
umask 077 # backups hold customer data: readable by this user only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$API_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
RESTORE_DB="${RESTORE_TEST_DB:-vergepay_restore_test}"
LOG_FILE="$BACKUP_DIR/backup.log"
MIN_PG_MAJOR=17
[[ -n "${PG_BIN:-}" ]] && PATH="$PG_BIN:$PATH"

CLEANUP=() # files to delete if the run stops early

usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line" >&2
  echo "$line" >>"$LOG_FILE"
}
die() {
  log "FAILED: $*"
  exit 1
}

on_exit() { ((${#CLEANUP[@]})) && rm -f -- "${CLEANUP[@]}"; return 0; }
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO: $BASH_COMMAND"' ERR
trap 'die "stopped by a signal"' INT TERM

require() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool isn't installed (or isn't on PATH)"
  done
}

# Major version of a PostgreSQL tool: "pg_dump (PostgreSQL) 17.6" → 17
pg_major() { "$1" --version | grep -oE '[0-9]+' | head -n 1; }

require_pg() {
  local tool major
  for tool in "$@"; do
    require "$tool"
    major="$(pg_major "$tool")"
    ((major >= MIN_PG_MAJOR)) || die "$tool is version $major; version $MIN_PG_MAJOR or newer is needed (set PG_BIN to pick one)"
  done
}

# One value from the API's .env. That file is written for dotenv, not bash
# ("KEY =value", Windows line endings), so it's read rather than sourced.
env_value() {
  local file="$API_DIR/.env"
  [[ -f "$file" ]] || return 0
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$file" |
    tail -n 1 | tr -d '\r' | sed -E "s/[[:space:]]+$//; s/^(['\"])(.*)\1$/\2/"
}

# Only one run at a time: a slow backup and the next cron run mustn't overlap.
take_lock() {
  require flock
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another backup run is still going"
}

backup() {
  local url stamp final tmp errors size tables deleted
  url="${DATABASE_URI:-$(env_value DATABASE_URI)}"
  [[ -n "$url" ]] || die "DATABASE_URI isn't set, and isn't in $API_DIR/.env"
  [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_DAYS must be a whole number of days, not '$KEEP_DAYS'"
  require_pg pg_dump
  require gzip

  stamp="$(date '+%Y-%m-%d_%H%M%S')"
  final="$BACKUP_DIR/vergepay-$stamp.sql.gz"
  tmp="$final.partial" # renamed only once complete, so a half-written backup never looks like a good one
  errors="$BACKUP_DIR/.pg_dump-errors"
  CLEANUP+=("$tmp" "$errors")

  # Only the public schema: Supabase's own schemas (auth, storage, ...) aren't
  # VergePay's to restore. No owners or grants, so it restores on any server.
  # (The URL, password included, shows in this machine's process list while
  # pg_dump runs: fine on a machine only you use.)
  if ! pg_dump --dbname="$url" --schema=public --no-owner --no-privileges 2>"$errors" | gzip -9 >"$tmp"; then
    die "the dump failed: $(tail -n 3 "$errors" | tr '\n' ' ')"
  fi

  # A finished plain-SQL dump ends with this line; anything else was cut short.
  # (grep without -q: -q stops reading early, and with pipefail the pipe would fail.)
  gzip -t "$tmp" || die "the compressed file is damaged"
  gzip -dc "$tmp" | tail -n 5 | grep 'PostgreSQL database dump complete' >/dev/null ||
    die "the dump is incomplete (no end marker)"

  mv -- "$tmp" "$final"
  size="$(du -h "$final" | cut -f 1)"
  tables="$(gzip -dc "$final" | grep -c '^CREATE TABLE' || true)"
  log "OK $(basename "$final") ($size, $tables tables)"

  # Rotation runs only after a good backup, so the newest backup is never deleted.
  deleted="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'vergepay-*.sql.gz' -mtime +"$KEEP_DAYS" -print -delete | wc -l)"
  ((deleted == 0)) || log "deleted $deleted backup(s) older than $KEEP_DAYS days"
}

restore_test() {
  local latest dump_tables tables users invoices server
  require_pg psql createdb dropdb
  require gzip

  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'vergepay-*.sql.gz' | sort | tail -n 1)"
  [[ -n "$latest" ]] || die "no backups in $BACKUP_DIR yet; run the script without options first"

  # pg_dump 17 writes settings that older servers reject, so the scratch server must be 17+ too.
  server="$(psql --no-psqlrc -d postgres -Atc 'SHOW server_version_num')" ||
    die "can't reach the local PostgreSQL server (check PGHOST / PGUSER / PGPASSWORD)"
  ((server / 10000 >= MIN_PG_MAJOR)) || die "the local server is PostgreSQL $((server / 10000)); $MIN_PG_MAJOR or newer is needed"

  # A fresh database each time; it's left in place afterwards for a look around.
  dropdb --if-exists "$RESTORE_DB"
  createdb "$RESTORE_DB"

  # The new database already has a public schema, so the dump's CREATE SCHEMA
  # line is skipped. ON_ERROR_STOP and one transaction: all of it or nothing.
  if ! gzip -dc "$latest" | sed '/^CREATE SCHEMA public;$/d' |
    psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction -d "$RESTORE_DB" >/dev/null; then
    die "restoring $(basename "$latest") into $RESTORE_DB failed (psql's error is above)"
  fi

  dump_tables="$(gzip -dc "$latest" | grep -c '^CREATE TABLE' || true)"
  tables="$(psql --no-psqlrc -d "$RESTORE_DB" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
  users="$(psql --no-psqlrc -d "$RESTORE_DB" -Atc 'SELECT count(*) FROM users')"
  invoices="$(psql --no-psqlrc -d "$RESTORE_DB" -Atc 'SELECT count(*) FROM invoices')"

  ((tables == dump_tables)) || die "the backup has $dump_tables tables but only $tables were restored"
  ((users > 0)) || die "restored, but the users table is empty"
  log "RESTORE OK $(basename "$latest") into $RESTORE_DB: $tables tables, $users users, $invoices invoices"
}

main() {
  case "${1:-}" in
  -h | --help)
    usage
    return
    ;;
  "" | --restore-test) ;;
  *)
    usage >&2
    exit 2
    ;;
  esac

  mkdir -p "$BACKUP_DIR"
  take_lock
  if [[ "${1:-}" == --restore-test ]]; then restore_test; else backup; fi
}

main "$@"
