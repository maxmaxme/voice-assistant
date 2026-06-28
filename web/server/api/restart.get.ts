// Whether the "Apply changes (restart)" button should render. The restart path
// writes to a host FIFO whose path comes from VA_UPDATE_FIFO; without it (e.g.
// local dev, or a deployment that didn't mount the FIFO) the button is hidden.
export default defineEventHandler(() => {
  return { available: Boolean(process.env.VA_UPDATE_FIFO) }
})
