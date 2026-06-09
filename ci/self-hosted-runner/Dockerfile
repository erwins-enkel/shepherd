# Shepherd self-hosted CI runner image.
#
# Base: myoung34/github-runner, pinned by digest (the `ubuntu-noble` tag at build time).
# Pinning by digest keeps the runner build reproducible and prevents a moved tag from
# silently swapping the base out from under us.
FROM myoung34/github-runner@sha256:067d61600d8ea770ce4940002bd817972282b4b691b047dd0c20fa3762489f71

# ---------------------------------------------------------------------------
# Bake Playwright's Chromium + system deps READ-ONLY into the image layer.
#
# WHY a baked image layer, not a shared volume:
#   This runner executes UNTRUSTED PR code, one fresh `docker run --rm` per job.
#   A shared writable browser cache volume would be a cross-job cache-poisoning
#   vector — job A could tamper with the browsers job B later runs. Baking the
#   browsers into the image at build time (a trusted step) means every --rm job
#   inherits its own copy-on-write copy of a known-good cache. No shared state.
#
# WHY this is only a warm-cache optimization (self-healing on drift):
#   PLAYWRIGHT_BROWSERS_PATH is exported below, so an in-job `playwright install`
#   resolves to the same path and finds the baked browsers already present —
#   a fast no-op when versions match. If ui/package.json's Playwright version
#   drifts from the baked 1.60.0, the in-job install simply re-downloads the
#   matching build into the ephemeral container layer. Drift therefore costs a
#   one-time download, never a build/job failure — so we do NOT pin-check here.
# ---------------------------------------------------------------------------

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Install Node 20 (NodeSource), replacing the base image's Node 18.
#
# WHY Node 20 specifically (not the base's v18, and not just "any npm"):
#   This node is used at JOB RUNTIME, not only at build time. The ui `check` step
#   runs `paraglide-js compile`, whose `.bin` shim is `#!/usr/bin/env node`, so it
#   executes under the CONTAINER's node. paraglide-js/inlang load a WASM SQLite that
#   needs the global Web Crypto API; on Node 18 it aborts with
#   "ReferenceError: crypto is not defined" (Aborted(initRandomDevice)). GitHub's
#   ubuntu-latest ships Node 20, where it works — so the runner must match it, or
#   every ui-touching PR fails here while passing on hosted runners. NodeSource
#   nodejs also provides npm/npx for the Playwright bake below.
# `playwright install --with-deps` needs root + apt; the base image's default
# user is root, which is what we want for the build steps.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
       npx --yes playwright@1.60.0 install --with-deps chromium \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Browsers are baked read-only for every job; widen perms so the in-job
# (possibly non-root) playwright can still read/no-op against them.
RUN chmod -R a+rX /opt/ms-playwright

# Do NOT override ENTRYPOINT / CMD / USER / WORKDIR — inherit the base
# (/entrypoint.sh + ./bin/Runner.Listener) so the container still behaves as a
# normal GitHub Actions runner.
