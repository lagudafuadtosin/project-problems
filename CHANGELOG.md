# Changelog

## 1.0.0

- Vue, Svelte and Astro: projects are checked with their own `vue-tsc`, `svelte-check` or `astro check`, so errors inside `.vue`, `.svelte` and `.astro` files show too.
- ESLint for the whole project, with the project's own ESLint and config (`projectProblems.eslint.enable`, off by default).
- When to check: `projectProblems.mode` is `watch` (as before), `onSave` or `manual`, with `projectProblems.checkOnStartup` for manual.
- New command: **Project Problems: Clear Problems**.
- Open files are only left to the editor when an extension there checks them; otherwise they are listed too.

## 0.1.0

First release.
