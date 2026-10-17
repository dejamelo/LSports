import { createApp } from "./app.js";
const port = Number(process.env.PORT || 3001);
const server = createApp().listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`API listening on ${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
