import { getAllSettings } from '../utils/db'
import { readRealtime } from '../utils/realtime'

export default defineEventHandler(() => readRealtime(getAllSettings()))
