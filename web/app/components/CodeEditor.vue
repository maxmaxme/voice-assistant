<script setup lang="ts">
import { EditorView } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'

const props = defineProps<{ modelValue: string, disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const el = ref<HTMLDivElement>()
const colorMode = useColorMode()
const theme = new Compartment()
const editable = new Compartment()
let view: EditorView | null = null

const sizing = EditorView.theme({
  '&': { fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '&.cm-focused': { outline: 'none' },
})

function themeExt() {
  // basicSetup brings a light highlight style; oneDark overrides it for dark mode.
  return colorMode.value === 'dark' ? oneDark : []
}

onMounted(() => {
  view = new EditorView({
    parent: el.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        sizing,
        theme.of(themeExt()),
        editable.of(EditorView.editable.of(!props.disabled)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
})

onBeforeUnmount(() => view?.destroy())

// External changes (prompt switch / reset) — replace the doc without feedback loop.
watch(() => props.modelValue, (val) => {
  if (view && val !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } })
  }
})
watch(() => props.disabled, d =>
  view?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!d)) }),
)
watch(() => colorMode.value, () =>
  view?.dispatch({ effects: theme.reconfigure(themeExt()) }),
)
</script>

<template>
  <div ref="el" />
</template>
