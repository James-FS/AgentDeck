/** Linear, bounded positional diff. Never runs quadratic LCS on untrusted text. */
export function boundedLineDiff(left: string, right: string) {
  const a = left.slice(0, 20_000).split('\n').slice(0, 2000);
  const b = right.slice(0, 20_000).split('\n').slice(0, 2000);
  return Array.from({ length: Math.min(2000, Math.max(a.length, b.length)) }, (_, index) => ({
    left: a[index] ?? '', right: b[index] ?? '', changed: a[index] !== b[index],
  }));
}
