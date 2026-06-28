<script setup lang="ts">
const { data: cap } = await useFetch<{ available: boolean }>('/api/restart')

const toast = useToast()
const open = ref(false)
const restarting = ref(false)

async function confirm() {
  restarting.value = true
  try {
    await $fetch('/api/restart', { method: 'POST' })
    toast.add({
      title: 'Restart triggered',
      description: 'voice-assistant is bouncing and will pick up your changes.',
      color: 'success',
    })
    open.value = false
  }
  catch (e: unknown) {
    toast.add({ title: 'Restart failed', description: errMessage(e), color: 'error' })
  }
  finally {
    restarting.value = false
  }
}
</script>

<template>
  <div v-if="cap?.available">
    <UButton
      block
      color="neutral"
      variant="solid"
      icon="i-lucide-rotate-cw"
      class="bg-white/15 text-white hover:bg-white/25 ring-0 justify-center"
      @click="open = true"
    >
      Apply changes (restart)
    </UButton>

    <UModal
      v-model:open="open"
      title="Restart voice-assistant?"
      description="Settings, prompts and integrations apply on the next start. This bounces the process to pick them up — any in-progress conversation is interrupted for a few seconds."
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            icon="i-lucide-rotate-cw"
            :loading="restarting"
            @click="confirm"
          >
            Restart
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
