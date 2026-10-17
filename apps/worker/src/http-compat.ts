/** Ticket LSports 217525 confirms userName on this route. SDK 3.10.10
 * requires username internally. Adapt only the final server-side JSON body;
 * do not rename integration variables or change regular football endpoints.
 */
export function marketRequestBody(data: unknown): unknown {
  const serialized = typeof data === 'string';
  const body = serialized ? JSON.parse(data) as unknown : data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid markets request body');
  const value = body as Record<string, unknown>;
  const { username, ...rest } = value;
  const userName = value.userName ?? username;
  const fixtures = rest.fixtures ?? [];
  if (typeof userName !== 'string' || !userName || typeof rest.password !== 'string' ||
      !Number.isSafeInteger(rest.packageId) || Number(rest.packageId) <= 0 || !Array.isArray(fixtures) || fixtures.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new Error('Invalid markets request credentials or fixture filter');
  const adapted = { ...rest, userName, fixtures };
  return serialized ? JSON.stringify(adapted) : adapted;
}
