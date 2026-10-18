// Terminal process groups and the dev supervisor may deliver the same signal.
// Register once, abort once, and let main's awaited finally blocks finish.
export function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) return;
    console.info(JSON.stringify({ operation: 'worker.shutdown', status: 'stopping' }));
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { signal: controller.signal, dispose() {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  } };
}
