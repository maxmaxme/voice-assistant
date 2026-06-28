import { getAllSettings } from '../utils/db/settings'
import { readRealtime } from '../utils/realtime'

export default defineEventHandler(() => readRealtime(getAllSettings()))
