// Express 4 does not catch a promise rejected by a handler: it becomes an
// unhandled rejection, which on current Node kills the process. Every async
// route goes through here so a throw becomes a 500 instead.
export function route(handler) {
  return (req, res, next) => handler(req, res, next).catch(next);
}
