#!/bin/sh
set -eu
# Pflicht: DB_HOST, DB_USER, DB_PASSWORD. Optional mit Defaults aus dem Plan.
: "${DB_HOST:?DB_HOST fehlt}"; : "${DB_USER:?DB_USER fehlt}"; : "${DB_PASSWORD:?DB_PASSWORD fehlt}"
DB_PORT="${DB_PORT:-5432}"
POOL_MODE="${POOL_MODE:-transaction}"
DEFAULT_POOL_SIZE="${DEFAULT_POOL_SIZE:-4}"
MIN_POOL_SIZE="${MIN_POOL_SIZE:-0}"
RESERVE_POOL_SIZE="${RESERVE_POOL_SIZE:-2}"
MAX_CLIENT_CONN="${MAX_CLIENT_CONN:-500}"
MAX_DB_CONNECTIONS="${MAX_DB_CONNECTIONS:-6}"
SERVER_IDLE_TIMEOUT="${SERVER_IDLE_TIMEOUT:-60}"
SERVER_LIFETIME="${SERVER_LIFETIME:-1800}"
SERVER_TLS_SSLMODE="${SERVER_TLS_SSLMODE:-prefer}"
CONF=/tmp/pgbouncer.ini; USERS=/tmp/userlist.txt
# TLS fuer Clients von aussen: selbstsigniertes Zertifikat je Start (Verschluesselung;
# Clients pruefen keine CA). Intern (ava-pgbouncer.internal) bleibt Klartext erlaubt.
KEY=/tmp/client.key; CRT=/tmp/client.crt
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CRT" -days 825 -subj "/CN=ava-pgbouncer.fly.dev" >/dev/null 2>&1
chmod 600 "$KEY"
# Passwort in der userlist mit doppelten Anfuehrungszeichen; Anfuehrungszeichen im Passwort verdoppeln.
PW_ESC=$(printf '%s' "$DB_PASSWORD" | sed 's/"/""/g')
printf '"%s" "%s"\n' "$DB_USER" "$PW_ESC" > "$USERS"
chmod 600 "$USERS"
cat > "$CONF" <<INI
[databases]
* = host=${DB_HOST} port=${DB_PORT} auth_user=${DB_USER}

[pgbouncer]
listen_addr = *
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${USERS}
admin_users = ${DB_USER}
stats_users = ${DB_USER}
pool_mode = ${POOL_MODE}
default_pool_size = ${DEFAULT_POOL_SIZE}
min_pool_size = ${MIN_POOL_SIZE}
reserve_pool_size = ${RESERVE_POOL_SIZE}
reserve_pool_timeout = 3
max_client_conn = ${MAX_CLIENT_CONN}
max_db_connections = ${MAX_DB_CONNECTIONS}
server_idle_timeout = ${SERVER_IDLE_TIMEOUT}
server_lifetime = ${SERVER_LIFETIME}
server_connect_timeout = 15
query_wait_timeout = 60
client_idle_timeout = 0
ignore_startup_parameters = extra_float_digits,search_path,options
server_tls_sslmode = ${SERVER_TLS_SSLMODE}
client_tls_sslmode = allow
client_tls_key_file = ${KEY}
client_tls_cert_file = ${CRT}
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
verbose = 0
INI
echo "pgbouncer: ${POOL_MODE}, pool ${DEFAULT_POOL_SIZE}/${MAX_DB_CONNECTIONS} je Datenbank, upstream ${DB_HOST}:${DB_PORT}"
exec pgbouncer "$CONF"
