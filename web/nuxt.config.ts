export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  routeRules: {
    '/': { redirect: '/settings' },
  },
  runtimeConfig: {
    // Path to the SQLite DB shared with the voice-assistant process. In Docker
    // this is the bind-mounted data volume; in dev it points at the sibling
    // repo's `data/` dir. voice-assistant owns the schema + migrations — this
    // app only reads/writes the `settings` and `prompts` tables.
    vaDbPath: process.env.VA_DB_PATH || '../data/assistant.db',
  },
  // better-sqlite3 is a native module — keep it external to the server bundle
  // so its prebuilt binary is loaded at runtime rather than inlined by rollup.
  nitro: {
    externals: { external: ['better-sqlite3'] },
  },
});
