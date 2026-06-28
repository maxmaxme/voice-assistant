<script setup lang="ts">
// A green favicon on the dev server, violet in the built prod image, so a local
// tab is never confused with the Pi. `import.meta.dev` is replaced at build time.
useHead({
  link: [{
    rel: 'icon',
    type: 'image/svg+xml',
    href: import.meta.dev ? '/favicon-dev.svg' : '/favicon.svg',
  }],
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
