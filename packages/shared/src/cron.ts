const RANGES = [59, 23, 31, 12, 7] as const;

export function cronMatches(expr: string, date: Date): boolean {
  const fields = parseCron(expr);
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const dayRestricted = !fields[2]!.has(-1);
  const dowRestricted = !fields[4]!.has(-1);
  for (let index = 0; index < 5; index += 1) {
    if (index === 2 && dayRestricted && dowRestricted) continue;
    if (index === 4 && dayRestricted && dowRestricted) continue;
    if (!fields[index]!.has(-1) && !fields[index]!.has(values[index]!)) return false;
  }
  if (dayRestricted && dowRestricted) {
    return fields[2]!.has(values[2]!) || fields[4]!.has(values[4]!);
  }
  return true;
}

export function nextCron(expr: string, from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`No occurrence within a year for ${expr}`);
}

function parseCron(expr: string): Set<number>[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expressions need 5 fields: minute hour day month weekday.');
  return parts.map((part, index) => expand(part, index === 3 ? 1 : 0, RANGES[index]!));
}

function expand(part: string, min: number, max: number): Set<number> {
  if (part === '*') return new Set([-1]);
  const values = new Set<number>();
  for (const piece of part.split(',')) {
    const [range, stepRaw] = piece.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Bad step in ${part}`);
    let start = min;
    let end = max;
    if (range !== '*') {
      const [a, b] = range!.split('-');
      start = Number(a);
      end = b == null ? start : Number(b);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new Error(`Bad range in ${part}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}
