export function yearsAgo(years: number, from: Date = new Date()): Date {
  const date = new Date(from);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date;
}
