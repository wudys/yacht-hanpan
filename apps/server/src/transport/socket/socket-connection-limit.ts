const DEFAULT_MAX_CONNECTIONS_PER_ADDRESS = 20;

export class SocketConnectionLimit {
  readonly #connectionIdsByAddress: Map<string, Set<string>> = new Map<string, Set<string>>();
  readonly #maxConnectionsPerAddress: number;

  public constructor(maxConnectionsPerAddress: number = DEFAULT_MAX_CONNECTIONS_PER_ADDRESS) {
    if (!Number.isSafeInteger(maxConnectionsPerAddress) || maxConnectionsPerAddress < 1) {
      throw new TypeError('Invalid socket connection limit');
    }
    this.#maxConnectionsPerAddress = maxConnectionsPerAddress;
  }

  public acquire(address: string, connectionId: string): boolean {
    const current = this.#connectionIdsByAddress.get(address) ?? new Set<string>();
    if (current.has(connectionId)) return true;
    if (current.size >= this.#maxConnectionsPerAddress) return false;
    current.add(connectionId);
    this.#connectionIdsByAddress.set(address, current);
    return true;
  }

  public release(address: string, connectionId: string): boolean {
    const current = this.#connectionIdsByAddress.get(address);
    if (current === undefined || !current.delete(connectionId)) return false;
    if (current.size === 0) this.#connectionIdsByAddress.delete(address);
    return true;
  }

  public count(address: string): number {
    return this.#connectionIdsByAddress.get(address)?.size ?? 0;
  }
}
