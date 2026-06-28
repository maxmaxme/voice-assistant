import { setPrompt, getPrompt, DbNotReadyError } from '../../utils/db';

interface PutBody {
  content?: string;
}

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name');
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Missing prompt name' });
  }
  const body = await readBody<PutBody>(event);
  if (typeof body?.content !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Expected { content: string }' });
  }
  // Only let the UI edit prompts that already exist — voice-assistant seeds the
  // editable ones from its bundled markdown on first run. Refuse arbitrary new
  // names so a typo can't create an orphan row the app never reads.
  if (!getPrompt(name)) {
    throw createError({ statusCode: 404, statusMessage: `No prompt named '${name}'` });
  }
  try {
    setPrompt(name, body.content);
  } catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message });
    }
    throw e;
  }
  return { ok: true, restartRequired: true };
});
