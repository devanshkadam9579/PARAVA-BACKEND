/**
 * Calculates dynamic commission, taxes, and vendor net payout
 * @param {number} totalAmount Total booking value in INR
 * @param {Object} config Admin configurable settings
 */
export function calculateVendorCommission(totalAmount, config = {}) {
  const amount = Number(totalAmount) || 0;
  const commissionPct = Number(config.commissionPercentage) || 10; // Default 10%
  const fixedFee = Number(config.fixedCommissionFee) || 0;
  const taxRate = Number(config.taxRate) || 0.18; // 18% GST on platform fee

  // Commission calculation
  const percentageFee = Math.round((amount * commissionPct) / 100);
  const platformCommission = percentageFee + fixedFee;
  const gstOnCommission = Math.round(platformCommission * taxRate * 100) / 100;
  
  // Net payout to vendor
  const vendorPayout = Math.max(0, amount - platformCommission);

  return {
    totalBookingAmount: amount,
    commissionPercentage: commissionPct,
    platformCommission,
    gstOnCommission,
    totalPlatformFeeWithTax: platformCommission + gstOnCommission,
    vendorPayout,
    currency: 'INR',
    calculatedAt: new Date().toISOString()
  };
}
