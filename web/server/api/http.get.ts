import { getAllSettings } from '../utils/db/settings'
import { readHttp } from '../utils/http'

export default defineEventHandler(() => readHttp(getAllSettings()))
