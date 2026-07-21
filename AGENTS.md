# AGENTS.md

pi-statusline: a configurable status footer extension for [pi](https://github.com/earendil-works/pi-mono).

## Commands

- `npm test` — run tests (`node --test test/*.test.ts`)
- `npm run typecheck` — `tsc --noEmit`
- `pi -e .` — try the extension locally without installing

## Layout

- `extensions/statusline.ts` — pi extension entry point (registers the footer + `/statusline` command)
- `src/` — segment logic (`bar`, `config`, `derive`, `format`, `git`, `ratelimit`, `segments`, `throughput`)
- `test/` — one test file per `src/` module
