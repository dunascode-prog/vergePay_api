// Date ranges named in a question ("last month", "in September", "Q3",
// "this year", "the last 30 days"), as inclusive local dates (YYYY-MM-DD)
// in the customer's timezone. Pure functions, so they're easy to test.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(\d{4}))?/;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/** "2026-10-08" → { y, m, d } */
const parts = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
};

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date, days) {
  const { y, m, d } = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The local date of an instant in a timezone ("Africa/Lagos"). */
export function localDate(instant, timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

const monthRange = (y, m) => ({ from: ymd(y, m, 1), to: ymd(y, m, daysIn(y, m)) });
const label = (from, to, words) => ({ from, to, label: words });
const monthName = (m) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

/**
 * The period a question names, or null if it names none. `today` is the
 * customer's local date. A month without a year means the most recent one
 * (asking in October about "December" means last December).
 */
export function parsePeriod(question, today) {
  const q = question.toLowerCase();
  const { y, m } = parts(today);

  let match;
  if ((match = q.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/))) {
    const n = Math.min(Number(match[1]), 366);
    return label(addDays(today, -(n - 1)), today, `the last ${n} days`);
  }
  if (/\btoday\b/.test(q)) return label(today, today, "today");
  if (/\byesterday\b/.test(q)) return label(addDays(today, -1), addDays(today, -1), "yesterday");
  if (/\b(this|current)\s+week\b/.test(q)) {
    const dow = (new Date(Date.UTC(y, m - 1, parts(today).d)).getUTCDay() + 6) % 7; // Monday = 0
    return label(addDays(today, -dow), today, "this week");
  }
  if (/\b(last|previous|past)\s+week\b/.test(q)) {
    const dow = (new Date(Date.UTC(y, m - 1, parts(today).d)).getUTCDay() + 6) % 7;
    const start = addDays(today, -dow - 7);
    return label(start, addDays(start, 6), "last week");
  }
  if (/\b(this|current)\s+month\b|\bso far this month\b|\bmonth to date\b/.test(q)) return label(ymd(y, m, 1), today, "this month");
  if (/\b(last|previous|past)\s+month\b/.test(q)) {
    const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const r = monthRange(ly, lm);
    return label(r.from, r.to, `${monthName(lm)} ${ly}`);
  }
  if ((match = q.match(/\bq([1-4])\b(?:\s+(\d{4}))?/))) {
    const quarter = Number(match[1]);
    let qy = match[2] ? Number(match[2]) : y;
    if (!match[2] && (quarter - 1) * 3 + 1 > m) qy -= 1; // a quarter that hasn't started yet means last year's
    const from = ymd(qy, (quarter - 1) * 3 + 1, 1);
    const to = monthRange(qy, quarter * 3).to;
    return label(from, to < today ? to : today, `Q${quarter} ${qy}`);
  }
  if (/\b(last|previous)\s+year\b/.test(q)) return label(ymd(y - 1, 1, 1), ymd(y - 1, 12, 31), String(y - 1));
  if (/\b(this|current)\s+year\b|\bso far this year\b|\byear to date\b|\bytd\b/.test(q)) return label(ymd(y, 1, 1), today, "this year");
  if ((match = q.match(/\b(?:since|from)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/))) {
    const mm = MONTHS.findIndex((name) => name.startsWith(match[1].slice(0, 3))) + 1;
    const sy = mm > m ? y - 1 : y;
    return label(ymd(sy, mm, 1), today, `since ${monthName(mm)} ${sy}`);
  }
  if ((match = q.match(MONTH_RE))) {
    // "may" is also an ordinary word: only take it as a month after "in"/"for"/"during"
    if (match[1] === "may" && !/\b(in|for|during|of)\s+may\b/.test(q)) return null;
    const mm = MONTHS.findIndex((name) => name.startsWith(match[1].slice(0, 3))) + 1;
    const my = match[2] ? Number(match[2]) : mm > m ? y - 1 : y;
    const r = monthRange(my, mm);
    return label(r.from, r.to < today ? r.to : today, `${monthName(mm)} ${my}`);
  }
  if ((match = q.match(/\b(20\d{2})\b/))) {
    const yy = Number(match[1]);
    return label(ymd(yy, 1, 1), yy === y ? today : ymd(yy, 12, 31), String(yy));
  }
  return null;
}

/** The default when a question names no period. */
export const defaultPeriod = {
  thisMonth: (today) => label(today.slice(0, 8) + "01", today, "this month"),
  last30: (today) => label(addDays(today, -29), today, "the last 30 days"),
  thisYear: (today) => label(today.slice(0, 5) + "01-01", today, "this year"),
  allTime: (today) => label("2000-01-01", today, "all time"),
};

export const inPeriod = (date, period) => date >= period.from && date <= period.to;
