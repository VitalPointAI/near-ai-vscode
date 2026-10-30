// Calendar-day helpers for the report.

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function groupByDay(events) {
  const days = {};
  for (const event of events) {
    const key = dayKey(event.at);
    (days[key] = days[key] || []).push(event);
  }
  return days;
}

module.exports = { dayKey, groupByDay };
