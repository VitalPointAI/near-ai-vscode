const { groupByDay } = require('./days');

// One row per day, oldest first: how many sales and their total amount, to the cent.
function dailyTotals(events) {
  const days = groupByDay(events);
  return Object.keys(days).sort().map((day) => ({
    day,
    count: days[day].length,
    amount: Math.round(days[day].reduce((sum, event) => sum + event.amount * 100, 0)) / 100
  }));
}

module.exports = { dailyTotals };
