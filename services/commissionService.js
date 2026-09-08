/**
 * PARVA PLATFORM — DYNAMIC VENDOR COMMISSION SERVICE
 * Version 2.0.0
 * 
 * Rules:
 * - Dynamic Admin commission percentage from settings/global.commissionPercentage
 * - Commission calculated on discounted subtotal (after valid coupon discount)
 * - Vendor net payout and platform revenue snapshot
 * - Never hardcoded
 */

export function calculateVendorCommission({
  subtotal = 0,
  discount = 0,
  commissionPercentage = 10,
  fixedCommissionFee = 0,
  taxRate = 0.18
} = {}) {
  const numSubtotal = Math.max(0, Number(subtotal) || 0);
  const numDiscount = Math.max(0, Number(discount) || 0);
  const discountedSubtotal = Math.max(0, numSubtotal - numDiscount);
  const commissionPct = typeof commissionPercentage === 'number' ? commissionPercentage : (Number(commissionPercentage) || 10);
  const fixedFee = Number(fixedCommissionFee) || 0;
  const numTaxRate = Number(taxRate) || 0.18;

  // Percentage platform commission
  const percentageFee = Math.round((discountedSubtotal * commissionPct) / 100);
  const platformCommission = percentageFee + fixedFee;
  const gstOnCommission = Math.round(platformCommission * numTaxRate * 100) / 100;
  
  // Net payout to vendor on event day
  const vendorPayout = Math.max(0, discountedSubtotal - platformCommission);

  return {
    subtotal: numSubtotal,
    discount: numDiscount,
    discountedSubtotal,
    commissionPercentage: commissionPct,
    platformCommission,
    gstOnCommission,
    totalPlatformFeeWithTax: platformCommission + gstOnCommission,
    vendorPayout,
    currency: 'INR',
    calculatedAt: new Date().toISOString()
  };
}
