import { PlatformStore } from "@lsports/feed-store/platform";
const store = new PlatformStore();
try {
  await store.bootstrap(
    process.env.PLATFORM_BOOTSTRAP_EMAIL,
    process.env.PLATFORM_BOOTSTRAP_PASSWORD,
  );
  console.log(
    JSON.stringify({
      operation: "platform.bootstrap",
      status: "ok",
      message:
        "Administrador creado. Eliminá PLATFORM_BOOTSTRAP_PASSWORD del entorno.",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      operation: "platform.bootstrap",
      status: "error",
      code: (error as { code?: string }).code || "BOOTSTRAP_FAILED",
      message:
        "Revisá email, contraseña (12–256 caracteres), permisos y si el administrador ya existe. No se muestran valores.",
    }),
  );
  process.exitCode = 1;
} finally {
  store.close();
}
