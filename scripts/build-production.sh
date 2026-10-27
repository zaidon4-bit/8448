#!/usr/bin/env sh
set -eu

# Vite and @vitejs/plugin-react are build-time dependencies in package.json.
# Keep devDependencies installed so production builds work even when NODE_ENV=production.
npm install --include=dev --no-audit --no-fund
npm run build
