# Production build setup

The project declares `vite` and `@vitejs/plugin-react` in `devDependencies`, which is correct for build tooling. The `.npmrc` file includes development dependencies during install so the build does not fail with `vite: not found` when the environment has `NODE_ENV=production` or omits development dependencies by default.

## Local build

```sh
npm install --include=dev --no-audit --no-fund
npm run build
```

Or run `./scripts/build-production.sh`.

## Render

Use this Build Command:

```sh
npm install --include=dev --no-audit --no-fund && npm run build
```

Keep the Start Command as `npm start` unless your service uses a different configured start command.

## Verification status

The source checks and 13 automated tests passed in the available environment. A production build could not be completed here because package-registry DNS requests failed (`EAI_AGAIN`), so Vite could not be downloaded locally. Re-run the build in an environment with access to the npm registry to verify the generated `dist/` output.
