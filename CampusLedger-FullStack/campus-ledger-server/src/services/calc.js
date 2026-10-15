// Pure business rules. Nothing here touches the database, so it is easy to test.

const pct = (attended, counted) => (counted > 0 ? Math.round((100 * attended) / counted) : 100);

const average = list => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

/**
 * Splits what a student has paid across their fee heads, oldest due date first.
 * Balances are always derived like this; no balance column is stored.
 * heads: [{id, name, amount_paise, due_date}]  discounts: Map(headId -> paise)  paid: total paise
 */
function computeDues(heads, discounts, paid, today) {
  const sorted = [...heads].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id));
  let left = paid;
  return sorted.map(h => {
    const discount = Math.min(discounts.get(h.id) || 0, h.amount_paise);
    const net = h.amount_paise - discount;
    const got = Math.min(net, left);
    left -= got;
    const balance = net - got;
    const status = balance === 0 ? 'Paid' : h.due_date < today ? 'Overdue' : got > 0 ? 'Partial' : 'Pending';
    return { feeHeadId: h.id, head: h.name, gross: h.amount_paise, discount, net, paid: got, balance, dueDate: h.due_date, status };
  });
}

const totals = dues => dues.reduce((a, d) => ({ net: a.net + d.net, paid: a.paid + d.paid, balance: a.balance + d.balance }), { net: 0, paid: 0, balance: 0 });

module.exports = { pct, average, computeDues, totals };
