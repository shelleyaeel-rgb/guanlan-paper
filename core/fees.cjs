const { money } = require('./common.cjs');
function fees(gross, side, settings) {
  const commission = Math.max(money(settings.minCommission), Math.round(gross * settings.commission));
  const stampTax = side === 'sell' ? Math.round(gross * settings.stampTax) : 0;
  const transferFee = Math.round(gross * settings.transferFee);
  return { commission, stampTax, transferFee, total: commission + stampTax + transferFee };
}
module.exports = { fees };
