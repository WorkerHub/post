// Stub for Cloudflare's `cloudflare:sockets` module, which is unavailable in
// the Node test environment. Tests that need a real SMTP conversation install a
// fake socket factory via `setConnectFactory`; everything else keeps the
// original "not available" behaviour.
type ConnectFactory = (address: unknown, options?: unknown) => unknown;

let factory: ConnectFactory | undefined;

export function setConnectFactory(fn: ConnectFactory | undefined): void {
  factory = fn;
}

export function connect(address: unknown, options?: unknown): any {
  if (!factory) {
    throw new Error(
      "cloudflare:sockets connect is not available in unit tests",
    );
  }
  return factory(address, options);
}
