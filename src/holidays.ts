// holidays.ts: US holidays and observances the planner and copywriter should know about,
// computed for any year (no external data). Each may carry a seasonal theme name that maps
// to color overrides in brand.json "seasonal".

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  /** Theme key in brand.json seasonal.themes, or null for brand colors. */
  theme: string | null;
  /** Posting worth it on this day even if it is a weekend. */
  post: boolean;
  /** Short note for the planner. */
  note: string;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** nth (1-based) weekday (0=Sun) of a month; nth=-1 for the last one. */
function nthWeekday(y: number, m: number, weekday: number, nth: number): string {
  if (nth > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((last - weekday + 7) % 7));
}

/** Western Easter (Anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function holidaysForYear(y: number): Holiday[] {
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  return [
    { date: iso(y, 1, 1), name: "New Year's Day", theme: 'newyear', post: true, note: 'Fresh starts; a good day for a "this year, fix the website" angle.' },
    { date: nthWeekday(y, 1, 1, 3), name: 'Martin Luther King Jr. Day', theme: null, post: false, note: 'Observed Monday. Keep the tone respectful; avoid salesy copy.' },
    { date: iso(y, 2, 14), name: "Valentine's Day", theme: 'valentine', post: true, note: 'Light touch: "love your website again".' },
    { date: nthWeekday(y, 2, 1, 3), name: "Presidents' Day", theme: null, post: false, note: 'Observed Monday; many offices closed.' },
    { date: iso(y, 3, 17), name: "St. Patrick's Day", theme: 'stpatricks', post: true, note: 'Green accents; playful.' },
    { date: easter(y), name: 'Easter', theme: 'spring', post: false, note: 'Sunday; family day, low engagement. Skip unless there is a reason.' },
    { date: nthWeekday(y, 5, 1, -1), name: 'Memorial Day', theme: 'patriotic', post: false, note: 'Observed Monday; sombre. No sales pitch.' },
    { date: iso(y, 6, 19), name: 'Juneteenth', theme: null, post: false, note: 'Federal holiday; keep tone respectful.' },
    { date: iso(y, 7, 4), name: 'Independence Day', theme: 'patriotic', post: true, note: 'Red, white and blue; short and celebratory.' },
    { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day', theme: null, post: false, note: 'Observed Monday; long weekend.' },
    { date: iso(y, 10, 31), name: 'Halloween', theme: 'halloween', post: true, note: 'Orange and purple; "scary website" jokes land well.' },
    { date: iso(y, 11, 11), name: 'Veterans Day', theme: 'patriotic', post: false, note: 'Respectful; no promotion.' },
    { date: thanksgiving, name: 'Thanksgiving', theme: 'autumn', post: true, note: 'Gratitude to clients; warm tones.' },
    { date: addDays(thanksgiving, 1), name: 'Black Friday', theme: 'autumn', post: true, note: 'Only if there is a real offer; otherwise skip.' },
    { date: addDays(thanksgiving, 2), name: 'Small Business Saturday', theme: 'autumn', post: true, note: 'Our audience exactly: shop local, support small business sites.' },
    { date: iso(y, 12, 24), name: 'Christmas Eve', theme: 'christmas', post: true, note: 'Short seasonal greeting.' },
    { date: iso(y, 12, 25), name: 'Christmas Day', theme: 'christmas', post: true, note: 'Greeting only; no pitch.' },
    { date: iso(y, 12, 31), name: "New Year's Eve", theme: 'newyear', post: true, note: '"Next year" angle.' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

export function holidayOn(date: string): Holiday | null {
  const y = Number(date.slice(0, 4));
  return holidaysForYear(y).find((h) => h.date === date) ?? null;
}

/** Holidays within [start, end] inclusive. */
export function holidaysBetween(start: string, end: string): Holiday[] {
  const y1 = Number(start.slice(0, 4)), y2 = Number(end.slice(0, 4));
  const all = y1 === y2 ? holidaysForYear(y1) : [...holidaysForYear(y1), ...holidaysForYear(y2)];
  return all.filter((h) => h.date >= start && h.date <= end);
}

/** A loose seasonal theme for dates near (within `days` before) a themed holiday, e.g. the run-up to Christmas. */
export function seasonFor(date: string, days = 10): string | null {
  const y = Number(date.slice(0, 4));
  for (const h of [...holidaysForYear(y), ...holidaysForYear(y + 1)]) {
    if (!h.theme) continue;
    const diff = (Date.parse(h.date) - Date.parse(date)) / 86_400_000;
    if (diff >= 0 && diff <= days) return h.theme;
  }
  return null;
}
