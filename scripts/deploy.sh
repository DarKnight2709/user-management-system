#!/usr/bin/env bash
# Deploys the backend on the VPS. Run from the application directory:
#   bash scripts/deploy.sh <image-tag>
#
# Order: pull images, back up the database, migrate, start, wait for health.
# If the new backend never becomes healthy, the previous image is restarted.
# Migrations are not rolled back, so each one must keep working with the
# previous version. Restore a backup by hand only when one does not.
set -euo pipefail

readonly COMPOSE_FILE="docker-compose.prod.yml"
readonly BACKEND_IMAGE="ghcr.io/darknight2709/ums-backend"
readonly BACKEND_CONTAINER="ums-backend"
readonly BACKUP_DIR="${HOME}/backups"
readonly BACKUPS_TO_KEEP=7
readonly DEPLOYED_TAG_FILE=".deployed-tag"
readonly HEALTH_ATTEMPTS=30
readonly HEALTH_INTERVAL_SECONDS=5

log() {
  printf '[deploy] %s\n' "$*"
}

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

last_deployed_tag() {
  if [ -f "${DEPLOYED_TAG_FILE}" ]; then
    cat "${DEPLOYED_TAG_FILE}"
  fi
}

backup_database() {
  local tag="$1"
  local backup_file
  backup_file="${BACKUP_DIR}/ums-$(date -u +%Y%m%dT%H%M%SZ)-before-${tag}.dump"

  mkdir -p "${BACKUP_DIR}"
  compose up -d --wait postgres
  log "backing up the database to ${backup_file}"

  # Credentials come from the container's own environment, not from this shell.
  if ! compose exec -T postgres sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    >"${backup_file}"; then
    rm -f -- "${backup_file}"
    log "database backup failed; nothing was changed"
    return 1
  fi

  if ! compose exec -T postgres pg_restore --list <"${backup_file}" >/dev/null; then
    rm -f -- "${backup_file}"
    log "database backup is not readable; nothing was changed"
    return 1
  fi
}

prune_old_backups() {
  # Newest first; everything after the first BACKUPS_TO_KEEP is removed.
  ls -1t "${BACKUP_DIR}"/ums-*.dump |
    tail -n +"$((BACKUPS_TO_KEEP + 1))" |
    while IFS= read -r old_backup; do
      rm -f -- "${old_backup}"
    done
}

# Tagged images are not dangling, so `docker image prune` would never free them.
prune_old_backend_images() {
  local current_tag="$1"
  local previous_tag="$2"

  docker images --format '{{.Repository}}:{{.Tag}}' "${BACKEND_IMAGE}" |
    { grep -v -e ":${current_tag}\$" -e ":${previous_tag}\$" -e ':latest$' || true; } |
    xargs -r docker rmi || true
}

backend_is_healthy() {
  local status
  status="$(docker inspect --format '{{.State.Health.Status}}' "${BACKEND_CONTAINER}" 2>/dev/null || echo missing)"
  [ "${status}" = "healthy" ]
}

wait_for_backend() {
  local attempt
  for attempt in $(seq 1 "${HEALTH_ATTEMPTS}"); do
    if backend_is_healthy; then
      return 0
    fi
    log "waiting for backend health (${attempt}/${HEALTH_ATTEMPTS})"
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  return 1
}

roll_back_to() {
  local tag="$1"

  log "rolling back to image ${tag}"
  BACKEND_IMAGE_TAG="${tag}" compose up -d backend
  if wait_for_backend; then
    log "rolled back to ${tag}"
  else
    log "image ${tag} is not healthy either; manual intervention is required"
  fi
}

main() {
  local new_tag="${1:?Usage: deploy.sh <image-tag>}"
  local previous_tag
  previous_tag="$(last_deployed_tag)"
  export BACKEND_IMAGE_TAG="${new_tag}"

  compose pull backend loki alloy grafana
  backup_database "${new_tag}"
  prune_old_backups

  # A failure here leaves the running version untouched.
  compose run --rm backend npx prisma migrate deploy
  compose run --rm --no-deps backend npm run prisma:seed:organization-permissions

  compose up -d --remove-orphans

  if wait_for_backend; then
    echo "${new_tag}" >"${DEPLOYED_TAG_FILE}"
    prune_old_backend_images "${new_tag}" "${previous_tag}"
    docker image prune -f
    log "deployed ${new_tag}"
    return 0
  fi

  docker logs --tail 50 "${BACKEND_CONTAINER}" || true
  if [ -n "${previous_tag}" ]; then
    roll_back_to "${previous_tag}"
  else
    log "no previous version is recorded; nothing to roll back to"
  fi
  return 1
}

main "$@"
