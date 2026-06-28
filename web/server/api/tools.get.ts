import { getAllSettings } from '../utils/db/settings'
import { readTools } from '../utils/tools'

export default defineEventHandler(() => readTools(getAllSettings()))
