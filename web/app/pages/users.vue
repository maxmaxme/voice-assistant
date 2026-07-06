<script setup lang="ts">
import type { Channel, Device, User, UsersResponse } from '~/types'

useHead({ title: 'Users' })

const toast = useToast()
const { data, refresh } = await useFetch<UsersResponse>('/api/users')

const CHANNELS: { label: string, value: Channel }[] = [
  { label: 'Telegram', value: 'telegram' },
  { label: 'HTTP token', value: 'http' },
  { label: 'Voice (speaker)', value: 'voice' },
]
const channelLabel = (c: Channel): string => CHANNELS.find(x => x.value === c)?.label ?? c
const channelIcon = (c: Channel): string =>
  c === 'telegram' ? 'i-lucide-send' : c === 'voice' ? 'i-lucide-speaker' : 'i-lucide-globe'

// telegram identity is a raw chat id (show it); http/voice are sha256 hashes
// (not secret, but long) — show a short prefix.
const showIdentity = (d: Device): string =>
  d.channel === 'telegram' ? d.identity : `${d.identity.slice(0, 12)}…`
const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

// ── User add / edit ──────────────────────────────────────────────────────
const userFormOpen = ref(false)
const userMode = ref<'create' | 'edit'>('create')
const userId = ref<number>()
const userForm = reactive({ name: '', isAdmin: false })
const savingUser = ref(false)

function openCreateUser() {
  userMode.value = 'create'
  userId.value = undefined
  userForm.name = ''
  userForm.isAdmin = false
  userFormOpen.value = true
}
function openEditUser(u: User) {
  userMode.value = 'edit'
  userId.value = u.id
  userForm.name = u.name
  userForm.isAdmin = u.isAdmin
  userFormOpen.value = true
}
async function submitUser() {
  savingUser.value = true
  try {
    if (userMode.value === 'create') {
      await $fetch('/api/users', { method: 'POST', body: { name: userForm.name, isAdmin: userForm.isAdmin } })
    }
    else {
      await $fetch(`/api/users/${userId.value}`, { method: 'PUT', body: { name: userForm.name, isAdmin: userForm.isAdmin } })
    }
    toast.add({ title: userMode.value === 'create' ? 'User created' : 'Saved', color: 'success' })
    userFormOpen.value = false
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Failed', description: errMessage(e), color: 'error' })
  }
  finally {
    savingUser.value = false
  }
}

const deleteUserTarget = ref<User>()
const deletingUser = ref(false)
async function confirmDeleteUser() {
  if (!deleteUserTarget.value) return
  deletingUser.value = true
  try {
    await $fetch(`/api/users/${deleteUserTarget.value.id}`, { method: 'DELETE' })
    toast.add({ title: 'User removed', color: 'success' })
    deleteUserTarget.value = undefined
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Remove failed', description: errMessage(e), color: 'error' })
  }
  finally {
    deletingUser.value = false
  }
}

// ── Device add / edit ────────────────────────────────────────────────────
const deviceFormOpen = ref(false)
const deviceMode = ref<'add' | 'edit'>('add')
const deviceUserId = ref<number>()
const deviceId = ref<number>()
const deviceChannel = ref<Channel>('telegram')
const deviceValue = ref('')
const savingDevice = ref(false)

function openAddDevice(u: User) {
  deviceMode.value = 'add'
  deviceUserId.value = u.id
  deviceId.value = undefined
  deviceChannel.value = 'telegram'
  deviceValue.value = ''
  deviceFormOpen.value = true
}
function openEditDevice(d: Device) {
  deviceMode.value = 'edit'
  deviceId.value = d.id
  deviceChannel.value = d.channel
  // telegram value is the editable chat id; voice token is write-only (we only
  // store its hash) so the field starts blank.
  deviceValue.value = d.channel === 'telegram' ? d.identity : ''
  deviceFormOpen.value = true
}

const deviceValueLabel = computed(() => {
  if (deviceChannel.value === 'telegram') return 'Chat ID'
  if (deviceChannel.value === 'http') return 'Token'
  return 'Device token'
})
// http/voice both hash their token and can auto-generate; telegram is a chat id.
const isTokenChannel = (c: Channel): boolean => c === 'http' || c === 'voice'
const deviceValueHelp = computed(() => {
  if (deviceChannel.value === 'telegram') return 'The Telegram chat id this user messages from.'
  if (deviceChannel.value === 'voice') {
    return deviceMode.value === 'add'
      ? 'The token this speaker presents on its WebSocket connection (goes in the firmware\'s secrets.yaml). Leave blank to generate a strong random token (shown once).'
      : 'Enter a new token, or use Re-mint to generate a random one. Stored as a hash.'
  }
  // http
  return deviceMode.value === 'add'
    ? 'Leave blank to generate a strong random token (shown once).'
    : 'Enter a new token, or use Re-mint to generate a random one.'
})
const devicePlaceholder = computed(() =>
  isTokenChannel(deviceChannel.value) && deviceMode.value === 'add' ? '(auto-generated if blank)' : '',
)
// http/voice on add may be blank (= generate); everything else needs a value.
const canSubmitDevice = computed(() =>
  (isTokenChannel(deviceChannel.value) && deviceMode.value === 'add') || deviceValue.value.trim().length > 0,
)

async function submitDevice() {
  savingDevice.value = true
  try {
    if (deviceMode.value === 'add') {
      const res = await $fetch<{ token?: string }>(`/api/users/${deviceUserId.value}/devices`, {
        method: 'POST',
        body: { channel: deviceChannel.value, value: deviceValue.value },
      })
      toast.add({ title: 'Device added', color: 'success' })
      if (res?.token) revealToken(res.token)
    }
    else {
      await $fetch(`/api/devices/${deviceId.value}`, { method: 'PUT', body: { value: deviceValue.value } })
      toast.add({ title: 'Device updated', color: 'success' })
    }
    deviceFormOpen.value = false
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Failed', description: errMessage(e), color: 'error' })
  }
  finally {
    savingDevice.value = false
  }
}

async function remint() {
  savingDevice.value = true
  try {
    const res = await $fetch<{ token: string }>(`/api/devices/${deviceId.value}/remint`, { method: 'POST' })
    deviceFormOpen.value = false
    await refresh()
    revealToken(res.token)
  }
  catch (e: unknown) {
    toast.add({ title: 'Re-mint failed', description: errMessage(e), color: 'error' })
  }
  finally {
    savingDevice.value = false
  }
}

const deleteDeviceTarget = ref<Device>()
const deletingDevice = ref(false)
async function confirmDeleteDevice() {
  if (!deleteDeviceTarget.value) return
  deletingDevice.value = true
  try {
    await $fetch(`/api/devices/${deleteDeviceTarget.value.id}`, { method: 'DELETE' })
    toast.add({ title: 'Device removed', color: 'success' })
    deleteDeviceTarget.value = undefined
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Remove failed', description: errMessage(e), color: 'error' })
  }
  finally {
    deletingDevice.value = false
  }
}

// ── Token reveal (shown once) ──────────────────────────────────────────────
const tokenValue = ref<string | null>(null)
function revealToken(t: string) {
  tokenValue.value = t
}
async function copyToken() {
  if (!tokenValue.value) return
  try {
    await navigator.clipboard.writeText(tokenValue.value)
    toast.add({ title: 'Copied', color: 'success' })
  }
  catch {
    // http (non-secure) contexts block the clipboard API — the user can select
    // the text manually instead.
    toast.add({ title: 'Copy unavailable — select the token manually', color: 'warning' })
  }
}
</script>

<template>
  <div>
    <header class="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">
          Users
        </h1>
        <p class="text-[var(--ui-text-muted)] mt-1">
          People and speakers, and the devices (Telegram chats, HTTP tokens, voice speakers) bound to them.
        </p>
      </div>
      <UButton
        icon="i-lucide-user-plus"
        class="shrink-0"
        @click="openCreateUser"
      >
        Add user
      </UButton>
    </header>

    <div
      v-if="(data?.users ?? []).length"
      class="space-y-3"
    >
      <UCard
        v-for="u in data!.users"
        :key="u.id"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-semibold">{{ u.name }}</span>
              <UBadge
                v-if="u.isAdmin"
                color="primary"
                variant="subtle"
              >
                admin
              </UBadge>
              <span class="text-xs text-[var(--ui-text-muted)]">#{{ u.id }} · since {{ fmtDate(u.createdAt) }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-pencil"
              @click="openEditUser(u)"
            >
              Edit
            </UButton>
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              @click="deleteUserTarget = u"
            >
              Remove
            </UButton>
          </div>
        </div>

        <div class="mt-4 border-t border-[var(--ui-border)] pt-3 space-y-2">
          <div
            v-for="d in u.devices"
            :key="d.id"
            class="flex items-center justify-between gap-3"
          >
            <div class="flex items-center gap-2 min-w-0">
              <UIcon
                :name="channelIcon(d.channel)"
                class="size-4 text-[var(--ui-text-muted)] shrink-0"
              />
              <span class="text-sm font-medium">{{ channelLabel(d.channel) }}</span>
              <code class="text-xs text-[var(--ui-text-muted)] truncate">{{ showIdentity(d) }}</code>
              <span class="text-xs text-[var(--ui-text-muted)]">
                · {{ d.lastUsedAt ? `used ${fmtDate(d.lastUsedAt)}` : 'never used' }}
              </span>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-pencil"
                @click="openEditDevice(d)"
              />
              <UButton
                color="error"
                variant="ghost"
                size="xs"
                icon="i-lucide-trash-2"
                @click="deleteDeviceTarget = d"
              />
            </div>
          </div>

          <p
            v-if="!u.devices.length"
            class="text-sm text-[var(--ui-text-muted)]"
          >
            No devices yet.
          </p>

          <UButton
            color="neutral"
            variant="subtle"
            size="xs"
            icon="i-lucide-plus"
            class="mt-1"
            @click="openAddDevice(u)"
          >
            Add device
          </UButton>
        </div>
      </UCard>
    </div>
    <p
      v-else
      class="text-sm text-[var(--ui-text-muted)]"
    >
      No users yet. Add one to bind a Telegram chat, HTTP token or voice speaker.
    </p>

    <!-- User add / edit -->
    <UModal
      v-model:open="userFormOpen"
      :title="userMode === 'create' ? 'Add user' : 'Edit user'"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="userForm.name"
              class="w-full"
              placeholder="Alex / living-room"
            />
          </UFormField>
          <UFormField
            label="Admin"
            description="Admins can run privileged commands (e.g. /update in Telegram)."
          >
            <USwitch v-model="userForm.isAdmin" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="userFormOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            :loading="savingUser"
            @click="submitUser"
          >
            {{ userMode === 'create' ? 'Create' : 'Save' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Delete user -->
    <UModal
      :open="!!deleteUserTarget"
      title="Remove user?"
      :description="`This removes '${deleteUserTarget?.name}' and all its devices. Any client using those tokens/chats will lose access.`"
      @update:open="(v: boolean) => { if (!v) deleteUserTarget = undefined }"
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deleteUserTarget = undefined"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="deletingUser"
            @click="confirmDeleteUser"
          >
            Remove
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Device add / edit -->
    <UModal
      v-model:open="deviceFormOpen"
      :title="deviceMode === 'add' ? 'Add device' : `Edit ${channelLabel(deviceChannel)} device`"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            v-if="deviceMode === 'add'"
            label="Type"
          >
            <USelect
              v-model="deviceChannel"
              class="w-full"
              :items="CHANNELS"
            />
          </UFormField>

          <UFormField
            :label="deviceValueLabel"
            :description="deviceValueHelp"
            :required="!isTokenChannel(deviceChannel)"
          >
            <UInput
              v-model="deviceValue"
              class="w-full"
              :type="deviceChannel === 'telegram' ? 'text' : 'password'"
              :placeholder="devicePlaceholder"
            />
          </UFormField>

          <p
            v-if="deviceChannel === 'voice'"
            class="text-xs text-[var(--ui-text-muted)]"
          >
            Voice is the realtime path for the
            <a
              href="https://github.com/maxmaxme/home-assistant-voice-pe"
              target="_blank"
              rel="noreferrer"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >home-assistant-voice-pe</a>
            firmware only.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deviceFormOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            v-if="deviceMode === 'edit' && isTokenChannel(deviceChannel)"
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-cw"
            :loading="savingDevice"
            @click="remint"
          >
            Re-mint
          </UButton>
          <UButton
            :loading="savingDevice"
            :disabled="!canSubmitDevice"
            @click="submitDevice"
          >
            {{ deviceMode === 'add' ? 'Add' : 'Save' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Delete device -->
    <UModal
      :open="!!deleteDeviceTarget"
      title="Remove device?"
      :description="deleteDeviceTarget ? `This unbinds the ${channelLabel(deleteDeviceTarget.channel)} device. That client loses access immediately.` : ''"
      @update:open="(v: boolean) => { if (!v) deleteDeviceTarget = undefined }"
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deleteDeviceTarget = undefined"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="deletingDevice"
            @click="confirmDeleteDevice"
          >
            Remove
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Token reveal (shown once) -->
    <UModal
      :open="!!tokenValue"
      title="Copy this token now"
      description="It is shown only once — only its hash is stored. Put it in the client: an HTTP client (Apple Shortcut header, etc.) or a speaker's firmware secrets.yaml."
      @update:open="(v: boolean) => { if (!v) tokenValue = null }"
    >
      <template #body>
        <div class="flex items-center gap-2">
          <code class="flex-1 min-w-0 break-all text-sm bg-[var(--ui-bg-muted)] rounded-md px-3 py-2">{{ tokenValue }}</code>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-copy"
            @click="copyToken"
          >
            Copy
          </UButton>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end w-full">
          <UButton @click="tokenValue = null">
            Done
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
