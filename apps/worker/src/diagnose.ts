import { loadPackageConfig, loadRuntimeConfig } from "./config.js";
import { diagnosePackage } from "./diagnose-runner.js";
import { describeFailure } from "./diagnostics.js";
async function main() {
  const shared = loadRuntimeConfig();
  let healthy = true;
  console.log(
    JSON.stringify({
      diagnostic: "LSports TRADE",
      mode: "connected",
      readOnly: true,
      message:
        "No inicia distribución, no consume mensajes ni modifica .env. El entorno de shell tiene precedencia sobre .env.",
    }),
  );
  for (const lane of ["prematch", "inplay"] as const) {
    try {
      const pkg = loadPackageConfig(lane);
      if (
        !(await diagnosePackage(pkg, shared, (r) =>
          console.log(JSON.stringify(r)),
        ))
      )
        healthy = false;
    } catch (error) {
      healthy = false;
      console.error(
        JSON.stringify({
          lane,
          status: "error",
          ...describeFailure(error, "config", "local"),
        }),
      );
    }
  }
  if (!healthy) process.exitCode = 1;
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "error",
      ...describeFailure(error, "config", "local"),
    }),
  );
  process.exitCode = 1;
});
