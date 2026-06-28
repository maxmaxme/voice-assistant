import { listPrompts } from '../../utils/db';

export default defineEventHandler(() => {
  return { prompts: listPrompts() };
});
