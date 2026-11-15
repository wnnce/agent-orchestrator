export function assertSafeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}
