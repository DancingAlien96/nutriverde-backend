#!/bin/sh
# Respaldo de NutriVerde: dump de MySQL + carpeta de uploads.
#
# Uso:   ./docker/backup.sh
# Cron:  0 3 * * *  /ruta/al/repo/docker/backup.sh >> /var/log/nutriverde-backup.log 2>&1
#
# La contraseña NO se pasa por la línea de comandos (sería visible en `ps`):
# se lee dentro del contenedor desde su propia variable de entorno.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/var/backups/nutriverde}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_CONTAINER="${DB_CONTAINER:-nutriverde-mysql}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-nutriverde_uploads}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

# --- Base de datos ---------------------------------------------------------
# --single-transaction evita bloquear la base durante el dump (InnoDB).
db_file="$BACKUP_DIR/db-$STAMP.sql.gz"
docker exec "$DB_CONTAINER" sh -c '
  exec mysqldump \
    -u root -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --routines --triggers --events \
    "$MYSQL_DATABASE"
' | gzip > "$db_file"

# gzip devuelve 0 aunque mysqldump falle, así que validamos el resultado.
if [ ! -s "$db_file" ] || ! gzip -t "$db_file" 2>/dev/null; then
  echo "ERROR: el dump de la base salió vacío o corrupto — se elimina." >&2
  rm -f "$db_file"
  exit 1
fi

# --- Uploads (comprobantes de pago, PDFs de planes) ------------------------
up_file="$BACKUP_DIR/uploads-$STAMP.tar.gz"
docker run --rm \
  -v "$UPLOADS_VOLUME":/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3 tar czf "/backup/uploads-$STAMP.tar.gz" -C /data .

# --- Retención -------------------------------------------------------------
find "$BACKUP_DIR" -name 'db-*.sql.gz'      -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "OK $STAMP  db=$(du -h "$db_file" | cut -f1)  uploads=$(du -h "$up_file" | cut -f1)"
