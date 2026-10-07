/** Fenwick tree over threshold buckets; mirrors contracts/libraries/ThresholdIndex.sol. */
export class Fenwick {
  private readonly nodes: bigint[];

  constructor(public readonly size: number) {
    this.nodes = new Array<bigint>(size + 1).fill(0n);
  }

  add(bucket: number, amount: bigint): void {
    if (bucket < 0 || bucket >= this.size) throw new Error(`bucket ${bucket} out of range`);
    for (let i = bucket + 1; i <= this.size; i += i & -i) this.nodes[i] += amount;
  }

  /** Sum of buckets 0..bucket inclusive; negative gives 0, past the end clamps. */
  prefix(bucket: number): bigint {
    if (bucket < 0) return 0n;
    let i = Math.min(bucket, this.size - 1) + 1;
    let sum = 0n;
    for (; i > 0; i -= i & -i) sum += this.nodes[i];
    return sum;
  }

  /** Sum of buckets from..to inclusive, clamped to the axis; empty ranges give 0. */
  range(from: number, to: number): bigint {
    const lo = Math.max(from, 0);
    const hi = Math.min(to, this.size - 1);
    if (lo > hi) return 0n;
    return this.prefix(hi) - this.prefix(lo - 1);
  }
}
