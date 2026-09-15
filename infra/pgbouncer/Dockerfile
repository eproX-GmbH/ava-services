# ava-pgbouncer (docs/PLAN_PGBOUNCER.md): eigener PgBouncer im Transaktionsmodus
# vor dem PgBouncer von Fly Managed Postgres. Konfiguration komplett aus
# Umgebungsvariablen (Secrets), keine Datei mit Passwort im Image.
FROM alpine:3.20
RUN apk add --no-cache pgbouncer postgresql16-client gettext openssl && adduser -S -D -H pgbouncer 2>/dev/null || true
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 6432
USER pgbouncer
ENTRYPOINT ["/entrypoint.sh"]
