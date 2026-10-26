export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
