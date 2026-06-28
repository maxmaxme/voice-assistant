import { getAllSettings } from '../utils/db/settings'
import { readTelegram } from '../utils/telegram'

export default defineEventHandler(() => readTelegram(getAllSettings()))
