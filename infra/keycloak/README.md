# Keycloak — AVA realm theme + config

The Keycloak fly app (`fly-keycloak-broken-bird-3701.fly.dev`) hosts the
`ava` realm that the desktop app authenticates against. Source for
the theme + the realm configuration script lives here so changes ship
through code review rather than the admin UI.

## Layout

```
infra/keycloak/
├── Dockerfile            # extends quay.io/keycloak/keycloak:24.0 with the ava theme
├── README.md             # this file
└── themes/
    └── ava/
        └── login/
            ├── theme.properties
            ├── resources/css/styles.css
            ├── resources/img/logo.svg
            └── messages/
                ├── messages_de.properties
                └── messages_en.properties
```

## One-time setup on a fresh Keycloak

1. **Bake the theme into the image and deploy.**

   ```sh
   cd infra/keycloak
   fly deploy \
     --app fly-keycloak-broken-bird-3701 \
     --dockerfile Dockerfile
   ```

2. **Apply realm + client settings** (registration, longer sessions,
   login theme, redirect URIs):

   ```sh
   KEYCLOAK_ADMIN_URL=https://fly-keycloak-broken-bird-3701.fly.dev \
   KEYCLOAK_ADMIN_USER=admin \
   KEYCLOAK_ADMIN_PASSWORD='…' \
   node ../scripts/keycloak-config.mjs
   ```

   The script is idempotent — re-running it after a theme tweak just
   re-applies the same settings.

3. **Verify** by opening the URL the script prints at the end. You
   should see:
   - the AVA logo at the top of the form
   - dark surface + emerald accent colors (matching the desktop app)
   - a "Registrieren" link below the password field
   - a "Passwort vergessen?" link

## Updating the theme

Edit `themes/ava/login/...`, then re-deploy via `fly deploy` from this
directory. No need to re-run the config script — only the theme files
changed.

The realm-level `loginTheme = "ava"` setting is already wired by the
config script; new theme files take effect immediately on the next
page load.

## Why this lives in `infra/`

The Keycloak fly app and its theme aren't part of any service's build
graph (the desktop app only consumes Keycloak's HTTP API at runtime),
so they don't belong under `services/` or any producer directory.
`infra/` mirrors the existing `infra/docker-compose.dev.yml` pattern —
shared substrate, deployed independently.
