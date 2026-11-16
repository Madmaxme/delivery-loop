/**
 * A value returned by the owner of a fact.
 * A writer accepts only this. An empty read stops. There is no substitute.
 */
export class Read {
  readonly owner: string;
  readonly value: string;

  private constructor(owner: string, value: string) {
    this.owner = owner;
    this.value = value;
  }

  static required(owner: string, value: string | null | undefined): Read {
    const named = typeof value === "string" ? value.trim() : "";
    if (!named) throw new Error(`${owner} returned nothing`);
    return new Read(owner, named);
  }
}
