var test = require('node:test');
var assert = require('node:assert/strict');
var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

function billedOrder(items, coupon = '') {
  var totals = pricing.computeTotals(items, coupon);
  return {
    id: 1001,
    date: '23/11/2026',
    customer: 'Walk-in',
    status: 'completed',
    items: items,
    coupon: coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

function mixedSlabItems() {
  // Checkout saves HSN on order lines without a gstRate field.
  return [
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ];
}

test('checkout caps the coupon and charges line GST after the apportioned discount', function () {
  var { lines, ...totals } = pricing.computeTotals(mixedSlabItems(), 'SAVE10');

  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 150,
    taxable: 1850,
    tax: 157.25,
    cgst: 78.63,
    sgst: 78.62,
    total: 2007.25
  });
  assert.deepEqual(lines.map(function (line) {
    return [line.gstPercent, line.discount, line.taxable, line.tax, line.net];
  }), [
    [5, 75, 925, 46.25, 971.25],
    [12, 75, 925, 111, 1036]
  ]);
});

test('invoice matches the billed total and shows discounted GST for each HSN slab', function () {
  var order = billedOrder(mixedSlabItems(), 'SAVE10');
  var { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures, {
    subtotal: 2000,
    discount: 150,
    tax: 157.25,
    cgst: 78.63,
    sgst: 78.62,
    total: 2007.25
  });
  assert.deepEqual(rows.map(function (row) {
    return [row.hsn, row.gstPercent, row.lineTax];
  }), [
    ['1006', 5, 46.25],
    ['0405', 12, 111]
  ]);

  var html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹46\.25<\/td>/);
  assert.match(html, /<td class="r">12%<\/td><td class="r">₹111\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice and checkout both exclude an inactive coupon below its minimum', function () {
  var order = billedOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }], 'DIWALI20');

  assert.equal(order.discount, 0);
  assert.equal(order.total, 118);
  var figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.discount, 0);
  assert.equal(figures.total, 118);
});

test('invoice uses the same fractional gstRate as checkout', function () {
  var order = billedOrder([{ name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 0.05 }]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.total, 105);
});

test('reprinting preserves the billed discount when the saved coupon is now inactive', function () {
  var order = {
    ...billedOrder([{ name: 'Tea', hsn: '0902', price: 1000, qty: 1 }], 'DIWALI20'),
    discount: 200,
    tax: 144,
    total: 944
  };
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 200);
  assert.equal(figures.rows[0].lineTax, 144);
  assert.equal(figures.total, 944);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reprinting a pre-migration order preserves the flat GST recorded at checkout', function () {
  var order = {
    id: 1001,
    date: '21/07/2021',
    items: [
      { name: 'Rice', hsn: '1006', price: 100, qty: 1 },
      { name: 'Ghee', hsn: '0405', price: 50, qty: 1 }
    ],
    subtotal: 150,
    discount: 0,
    tax: 27,
    total: 177
  };
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, 177);
  assert.equal(figures.tax, 27);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[18, 18], [18, 9]]);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 0);
});

test('invoice GST adds up from the same rounded line taxes as checkout', function () {
  var items = [
    { name: 'Rice A', hsn: '1006', price: 0.1, qty: 1, gstRate: 5 },
    { name: 'Rice B', hsn: '1006', price: 0.1, qty: 1, gstRate: 5 }
  ];
  var order = billedOrder(items);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.22);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.22);
});

test('reprinting an older order preserves the total rounded before the discount was stored', function () {
  var order = {
    date: '21/07/2021',
    items: [{ name: 'Rice', hsn: '1006', price: 500.03, qty: 1 }],
    coupon: 'SAVE10',
    discount: 50,
    tax: 81,
    total: 531.03
  };
  ['21/07/2021', '22/07/2021'].forEach(function (date) {
    var figures = invoice.computeInvoiceFigures({ ...order, date: date });
    assert.equal(figures.total, 531.03);
    assert.equal(figures.rows[0].lineTax, 81);
  });
  var migrationDayOrder = {
    ...order,
    date: '22/07/2021',
    items: [{ name: 'Rice', hsn: '1006', price: 500.05, qty: 1 }],
    discount: 50.01,
    tax: 81.01,
    total: 531.06
  };
  assert.equal(invoice.computeInvoiceFigures(migrationDayOrder).total, 531.06);
  var subPaisaOrder = {
    ...migrationDayOrder,
    items: [{ name: 'Rice', hsn: '1006', price: 500.215, qty: 1 }],
    discount: 50.02,
    tax: 81.03,
    total: 531.22
  };
  assert.equal(invoice.computeInvoiceFigures(subPaisaOrder).total, 531.22);
  var flatRateOrder = {
    ...migrationDayOrder,
    items: [{ name: 'Rice', hsn: '1006', price: 502.75, qty: 1 }],
    coupon: '',
    discount: 0,
    tax: 90.49,
    total: 593.24
  };
  assert.equal(invoice.computeInvoiceFigures(flatRateOrder).total, 593.24);
});

test('migration-day reconciliation still flags an inconsistent undiscounted ledger total', function () {
  var order = {
    ...billedOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }]),
    date: '22/07/2021',
    tax: 18.01,
    total: 118.02
  };
  assert.equal(invoice.computeInvoiceFigures(order).total, 118);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 1);
  assert.equal(reports.getGstReconciliation({
    orders: [{ ...order, date: '21/07/2021' }]
  }).mismatchCount, 1);
  var discountedOrder = {
    ...order,
    items: [{ name: 'Rice', hsn: '1006', price: 500.01, qty: 1 }],
    coupon: 'SAVE10',
    discount: 50,
    tax: 81,
    total: 531.02
  };
  assert.equal(reports.getGstReconciliation({ orders: [discountedOrder] }).mismatchCount, 1);
});

test('flat-rate reprints preserve legacy subtotal rounding and allocate GST without negative lines', function () {
  var order = {
    date: '22/07/2021',
    items: [{ name: 'Rice', hsn: '1006', price: 1.005, qty: 1 }],
    discount: 0,
    tax: 0.18,
    total: 1.18
  };
  var figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.subtotal, 1);
  assert.equal(figures.rows[0].line, 1);

  figures = invoice.computeInvoiceFigures({
    ...order,
    date: '21/07/2021',
    items: Array.from({ length: 20 }, function () {
      return { name: 'Rice', hsn: '1006', price: 0.055, qty: 1 };
    }),
    tax: 0.2,
    total: 1.3
  });
  assert.equal(figures.tax, 0.2);
  assert.ok(figures.rows.every(function (row) { return row.lineTax >= 0; }));
  assert.equal(figures.rows.reduce(function (paise, row) {
    return paise + Math.round(row.lineTax * 100);
  }, 0), 20);
});

test('reconciliation compares recalculated invoice figures with saved ledger totals and skips cancellations', function () {
  var matching = billedOrder(mixedSlabItems(), 'SAVE10');
  var divergent = { ...matching, tax: 160, total: 2010 };
  matching.id = 1002;
  var cancelled = { ...divergent, id: 1003, status: 'cancelled' };
  var result = reports.getGstReconciliation({ orders: [divergent, matching, cancelled] });

  assert.equal(result.totalChecked, 2);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 2.75);
  assert.deepEqual(result.rows.map(function (row) {
    return [row.orderId, row.ledgerTax, row.invoiceTax, row.ledgerTotal, row.invoiceTotal, row.delta, row.matched];
  }), [
    [1001, 160, 157.25, 2010, 2007.25, -2.75, false],
    [1002, 157.25, 157.25, 2007.25, 2007.25, 0, true]
  ]);
  assert.match(invoice.render(divergent), /Accountant Reconciliation Notice/);
});
