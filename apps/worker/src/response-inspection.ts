import type { HttpResponseInspection } from '@lsports/contracts';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (v: unknown, present = true): HttpResponseInspection['root'] => !present ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'other';
const nonempty = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && (typeof v === 'string' ? !!v.trim() : Array.isArray(v) ? v.length > 0 : object(v) ? Object.keys(v).length > 0 : true);
// Output contains only fixed field names, types and counts. Never copy names, IDs,
// URLs, messages, HTML snippets or arbitrary object keys from a supplier response.
export function inspectResponse(data: unknown, contentType: unknown): HttpResponseInspection {
  const root = object(data) ? data : undefined;
  const header = root?.Header;
  const body = root?.Body;
  const known = ['Header', 'Body', 'header', 'body', 'Data', 'data', 'Error', 'error', 'Errors', 'errors', 'Id', 'Type', 'Events', 'Competition', 'Competitions', 'Markets', 'FixtureId'] as const;
  const errors = [object(header) ? header.Errors : undefined, root?.Errors, root?.errors, root?.Error, root?.error, object(body) ? body.Errors : undefined, object(body) ? body.Error : undefined, object(body) ? body.errors : undefined, object(body) ? body.error : undefined].filter(nonempty);
  const competitions = Array.isArray(body) ? body : object(body) ? [body] : [];
  const events = competitions.flatMap(c => object(c) && Array.isArray(c.Events) ? c.Events : []);
  const markets = events.flatMap(e => object(e) && Array.isArray(e.Markets) ? e.Markets : []);
  const bets = markets.flatMap(m => object(m) && Array.isArray(m.Bets) ? m.Bets : []);
  const mime = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  return {
    contentType: mime === 'application/json' || mime.endsWith('+json') ? 'json' : mime === 'text/html' ? 'html' : mime === 'text/plain' ? 'text' : mime ? 'other' : 'unspecified',
    root: shape(data), header: shape(header, !!root && Object.hasOwn(root, 'Header')),
    body: shape(body, !!root && Object.hasOwn(root, 'Body')),
    knownRootFields: root ? known.filter(k => Object.hasOwn(root, k)) : [],
    knownBodyFields: object(body) ? known.filter(k => Object.hasOwn(body, k)) : [],
    otherRootFields: root ? Object.keys(root).filter(k => !(known as readonly string[]).includes(k)).length : 0,
    applicationErrorFields: errors.length,
    applicationErrorItems: errors.reduce<number>((n, e) => n + (Array.isArray(e) ? e.length : 1), 0),
    competitionRows: competitions.length, eventRows: events.length, marketRows: markets.length, selectionRows: bets.length,
    bodyEmptyArray: Array.isArray(body) && body.length === 0,
    bodyEmptyObject: object(body) && Object.keys(body).length === 0,
    ...(object(header) ? { headerStatusType: shape(header.HttpStatusCode, Object.hasOwn(header, 'HttpStatusCode')) } : {}),
  };
}
