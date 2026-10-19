/** Serializes draft writes and only acknowledges the revision that actually reached storage. */
export class DraftSaver<T, R> {
  private value?: T;
  private revision = 0;
  private savedRevision = 0;
  private inFlight?: Promise<R | undefined>;

  constructor(private readonly persist: (value: T, previous: R | undefined) => Promise<R>, private resource?: R) {}

  initialize(value: T): void { this.value = value; }
  change(value: T): void { this.value = value; this.revision++; }
  get dirty(): boolean { return this.revision !== this.savedRevision; }

  /** Adopt an externally version-checked scribe update only after the editor was drained. */
  adopt(value: T, resource: R): void {
    if (this.dirty || this.inFlight) throw new Error('Save pending edits before adopting the scribe draft.');
    this.value = value; this.resource = resource;
  }

  flush(): Promise<R | undefined> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(): Promise<R | undefined> {
    while (this.value !== undefined && (this.dirty || this.resource === undefined)) {
      const revision = this.revision;
      this.resource = await this.persist(this.value, this.resource);
      this.savedRevision = revision;
    }
    return this.resource;
  }
}
