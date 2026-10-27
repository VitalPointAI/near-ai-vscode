const { groupByDay } = require('./days');

// One row per day, oldest first: how many sales and their total amount.
function dailyTotals(events) {
  const days = groupByDay(events);
  return Object.keys(days).sort().map((day) => ({
    day,
    count: days[day].length,
    amount: days[day].reduce((sum, event) => sum + event.amount, 0)
  }));
}

module.exports = { dailyTotals };
