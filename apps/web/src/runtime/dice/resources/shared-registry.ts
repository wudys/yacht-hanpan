export interface DisposableResource {
  dispose(): void;
}

export class SharedResourceRegistry<Resource extends DisposableResource> {
  private readonly create: () => Promise<Resource> | Resource;
  private resource: Resource | null = null;
  private loading: Promise<Resource> | null = null;

  public constructor(create: () => Promise<Resource> | Resource) {
    this.create = create;
  }

  public preload(): Promise<Resource> {
    if (this.resource) return Promise.resolve(this.resource);
    if (this.loading) return this.loading;
    this.loading = Promise.resolve()
      .then(() => this.create())
      .then((resource) => {
        this.resource = resource;
        return resource;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  public async dispose(): Promise<void> {
    const resource = this.resource ?? (this.loading ? await this.loading.catch(() => null) : null);
    if (!resource || resource !== this.resource) return;
    this.resource = null;
    resource.dispose();
  }
}
