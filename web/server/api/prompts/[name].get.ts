import { getPrompt } from '../../utils/db';

export default defineEventHandler((event) => {
  const name = getRouterParam(event, 'name');
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Missing prompt name' });
  }
  const prompt = getPrompt(name);
  if (!prompt) {
    throw createError({ statusCode: 404, statusMessage: `No prompt named '${name}'` });
  }
  return prompt;
});
