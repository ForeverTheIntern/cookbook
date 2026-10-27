/**
 * The one durable service the store needs, shaped like the Agent SDK's
 * `host.kv`, plus an in-memory version for tests. In @grok/agent-sdk 0.3.0 the
 * agent-facing `host.kv` has get, put and delete only: no list, no
 * compare-and-set and no expiry, so the store keeps its own index keys and
 * puts expiry timestamps inside values.
 */

export interface Kv {
  get(key: string): Promise<unknown>;
  put(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * host.kv in memory, behaving like Cursor hosting: values round-trip through
 * JSON, keys must be non-empty, there is nothing beyond get, put and delete,
 * and every call yields first, so calls from two runtimes interleave the way
 * network round trips do.
 */
export class MemoryKv implements Kv {
  readonly data = new Map<string, string>();
  ops = 0;
  async get(key: string) {
    await this.call(key);
    const v = this.data.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }
  async put(key: string, value: unknown) {
    await this.call(key);
    this.data.set(key, JSON.stringify(value));
  }
  async delete(key: string) {
    await this.call(key);
    this.data.delete(key);
  }
  private async call(key: string) {
    if (typeof key !== "string" || key.trim() === "") throw new Error("kv key must be a non-empty string");
    this.ops += 1;
    await new Promise((r) => setImmediate(r));
  }
}
