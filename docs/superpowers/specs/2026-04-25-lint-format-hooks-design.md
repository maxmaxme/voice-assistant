# Lint, Format & Git Hooks — Design

**Date:** 2026-04-25
**Status:** Approved

## Goal

Introduce baseline code-quality automation: ESLint, Prettier, and Git hooks that
enforce formatting/linting on commit and run typecheck + tests on push. Keep the
toolchain minimal and consistent with the project's "no build step, lean
dependencies" ethos.

## Non-goals

- CI pipeline (none exists yet).
- Type-checked ESLint rules (`recommended-type-checked`) — deferred; too slow for
  per-commit feedback at this stage.
- Reformatting Python (`scripts/wake_word_daemon.py`) — out of scope.

## Tooling

- **Hook runner:** `husky` (v9, flat hook scripts in `.husky/`).
- **Staged-file runner:** `lint-staged`.
- **Linter:** `eslint` v9 flat config with `@eslint/js` recommended +
  `typescript-eslint` recommended + `eslint-config-prettier`.
- **Formatter:** `prettier`.

All added as `devDependencies`.

## Configuration

### `eslint.config.js` (flat)

- Extends `@eslint/js` recommended and `typescript-eslint` recommended (non
  type-checked variant — fast, no tsconfig required for lint).
- Applies `eslint-config-prettier` last to disable stylistic rules that conflict
  with Prettier.
- Ignores: `node_modules/`, `data/`, `models/`, `coverage/`, `scripts/*.py`,
  `**/*.onnx`.
- Globals: `node` (via `globals` package).

### `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

### `.prettierignore`

```
node_modules
data
models
coverage
*.onnx
package-lock.json
```

### `package.json` additions

- `scripts`:
  - `lint`: `eslint .`
  - `lint:fix`: `eslint . --fix`
  - `format`: `prettier --write .`
  - `format:check`: `prettier --check .`
  - `prepare`: `husky`
- `lint-staged`:
  - `*.{ts,js}` → `eslint --fix`, then `prettier --write`
  - `*.{json,md,yml,yaml}` → `prettier --write`

### Hooks

- `.husky/pre-commit` → `npx lint-staged`
- `.husky/pre-push` → `npm run typecheck && npm test`

Hook scripts are POSIX `sh` and stay under five lines each.

## Rollout

1. Install deps and write configs/hooks.
2. Run `npm run format` and `npm run lint:fix` across the whole repo.
3. Manually inspect remaining ESLint errors; fix or, if a recommended rule
   genuinely fights project conventions, disable it explicitly in
   `eslint.config.js` with a one-line comment explaining why.
4. Commit configs + baseline reformat together as a single
   `chore: add eslint, prettier, and git hooks` commit (or split into config
   commit + baseline reformat commit if the diff is huge — decided at
   implementation time).
5. Verify hooks fire: a deliberate badly-formatted edit should be auto-fixed on
   commit; a deliberate type error should block push.

## Risks & mitigations

- **typescript-eslint recommended flags real issues in existing code.** Expected.
  Fix where reasonable; disable individual rules only with justification.
- **Hook bypass via `--no-verify`.** Accepted — local discipline only; CI can
  enforce later.
- **`prepare` script runs `husky` on `npm install`** which fails if `.git` is
  absent (e.g. in some Docker contexts). The Pi deployment image installs deps
  via `npm ci` inside a checked-out repo, so `.git` is present; should not
  affect deploy. If it ever does, switch `prepare` to `husky || true`.

## Open questions

None.
