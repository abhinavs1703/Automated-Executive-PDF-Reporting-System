// Small UTC date helpers shared by the analytics and the sample-data generator.
// No database or other heavy imports on purpose.
export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function dateString(date) {
  return utcDate(date).toISOString().slice(0, 10);
}

export function addDays(dateLike, days) {
  const date = new Date(`${dateLike}T00:00:00.000Z`);
  date.setTime(date.getTime() + days * DAY_MS);
  return dateString(date);
}

/** The default report period is the last fully completed Monday-Sunday week (UTC). */
export function getPreviousWeekRange(now = new Date()) {
  const today = utcDate(now);
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const thisMonday = new Date(today.getTime() - daysSinceMonday * DAY_MS);
  const endDate = dateString(new Date(thisMonday.getTime() - DAY_MS));
  return { startDate: addDays(endDate, -6), endDate };
}
