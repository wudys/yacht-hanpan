export class HttpRequestAdmission {
  readonly #maximumPending: number;
  #pendingCount: number = 0;

  public constructor(maximumPending: number = 128) {
    this.#maximumPending = maximumPending;
  }

  public get pendingCount(): number {
    return this.#pendingCount;
  }

  public acquire(): boolean {
    if (this.#pendingCount >= this.#maximumPending) return false;
    this.#pendingCount += 1;
    return true;
  }

  public release(): void {
    this.#pendingCount -= 1;
  }
}
