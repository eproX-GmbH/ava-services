# =============================================================================
# AVA-themed Keycloak image for fly-keycloak-broken-bird-3701.
#
# Pinned to 20.0.3 to match the existing deployment — the user's
# realm/client/user data lives on this version and we don't want a
# silent major-version bump (would auto-migrate the schema and is
# better done as a deliberate, scheduled change).
#
# What we add on top of the base image:
#   - /opt/keycloak/themes/ava/         (the AVA login theme)
#   - /opt/keycloak/conf/flyio-cache-config.xml  (preserves the
#     Infinispan cache config the app's start command references via
#     `--cache-config-file=flyio-cache-config.xml`; see fly.toml)
#
# The image inherits the upstream entrypoint, so the start command in
# fly.toml still drives Keycloak the same way.
#
# Build + deploy:
#
#   cd infra/keycloak
#   fly deploy -a fly-keycloak-broken-bird-3701
#
# After the deploy succeeds, run infra/scripts/keycloak-config.mjs once
# to set the realm's `loginTheme = "ava"` (and the other realm settings
# — registration, longer sessions, etc).
# =============================================================================

FROM quay.io/keycloak/keycloak:20.0.3

# Cache config — the existing fly app starts Keycloak with
# `--cache-config-file=flyio-cache-config.xml`, which is resolved
# under /opt/keycloak/conf/. Keep this file alongside the theme so
# rebuilding the image doesn't lose the multi-region cache wiring.
COPY conf/flyio-cache-config.xml /opt/keycloak/conf/flyio-cache-config.xml

# Theme tree: themes/ava/login/{theme.properties, resources/, messages/}
COPY themes/ /opt/keycloak/themes/
