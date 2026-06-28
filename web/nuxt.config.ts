export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Path to the SQLite DB shared with the voice-assistant process. In Docker
    // this is the bind-mounted data volume; in dev it points at the sibling
    // repo's `data/` dir. voice-assistant owns the schema + migrations — this
    // app only reads/writes the `settings` and `prompts` tables.
    vaDbPath: process.env.VA_DB_PATH || '../data/assistant.db',
  },
  routeRules: {
    '/': { redirect: '/settings' },
  },
  // better-sqlite3 is a native module — keep it external to the server bundle
  // so its prebuilt binary is loaded at runtime rather than inlined by rollup.
  nitro: {
    externals: { external: ['better-sqlite3'] },
  },
  // ESLint owns formatting in this project (ESLint Stylistic) instead of a
  // separate Prettier — one tool, no Prettier/ESLint conflicts, native .vue
  // support. `npm run lint -- --fix` applies it.
  eslint: {
    config: {
      stylistic: true,
    },
  },
})
