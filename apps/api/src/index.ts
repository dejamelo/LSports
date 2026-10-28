import { createApp } from "./app.js";
import {serverConfig} from "./server-config.js";
const {port,host}=serverConfig();
const app = createApp();
const server = app.listen(port, host, () =>
  console.log(`API listening on ${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => { app.locals.closeTickets(); app.locals.closeIndexedFeed?.(); process.exit(0); }));
