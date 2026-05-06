# =============================================================================
# AVA-themed Keycloak image.
#
# Bakes the `ava` login theme into the official Keycloak image so the
# fly app picks it up on next deploy. Keycloak loads themes from
# /opt/keycloak/themes/<name>/ at startup; we only need to COPY the
# tree there.
#
# Build + deploy:
#
#   cd infra/keycloak
#   fly deploy \
#     --app fly-keycloak-broken-bird-3701 \
#     --dockerfile Dockerfile \
#     --image-label ava-themed
#
# After the deploy succeeds, run infra/scripts/keycloak-config.mjs once
# to set the realm's `loginTheme = "ava"` (and the other §8.v3 realm
# settings — registration, longer sessions, etc).
#
# Why we don't fork the upstream image:
#   - Theme is purely additive (new directory under /opt/keycloak/themes).
#   - Pinning the base image tag below is enough for reproducibility.
#   - Upstream Keycloak releases ship security fixes monthly; bumping
#     here is a one-line change.
# =============================================================================

FROM quay.io/keycloak/keycloak:24.0

# Theme tree: themes/ava/login/{theme.properties, resources/, messages/}
COPY themes/ /opt/keycloak/themes/

# Same start command the existing fly app uses. Keep this in sync with
# the fly.toml [processes] entry on the keycloak app — overriding here
# would silently mask production env vars.
#
# Note: this Dockerfile is meant to be deployed to the EXISTING
# `fly-keycloak-broken-bird-3701` app, not a new one. The fly app
# already owns its database secrets, hostname, and KC_HOSTNAME config.
