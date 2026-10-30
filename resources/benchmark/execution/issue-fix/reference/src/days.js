// Calendar-day helpers for the report. Days are UTC calendar days.

function dayKey(timestamp) {
  const date = new Date(timestamp);
  if (timestamp === undefined || timestamp === null || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function groupByDay(events) {
  const days = {};
  for (const event of events) {
    const key = dayKey(event.at);
    if (!key) continue;
    (days[key] = days[key] || []).push(event);
  }
  return days;
}

module.exports = { dayKey, groupByDay };
