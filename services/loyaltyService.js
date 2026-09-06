/**
 * PARVA PLATFORM — AUTHORITATIVE CUSTOMER LOYALTY & REWARDS ENGINE
 * Version 1.0.0
 * 
 * Rules:
 * - Authoritative point balances derived from auditable transactional ledger
 * - Dynamic configurable tiers: STANDARD, SILVER, GOLD, PLATINUM
 * - Points earned on COMPLETED bookings (e.g. 1 pt per ₹100 spend)
 * - Automatic point reversal upon booking cancellation/refund
 * - Configurable expiration with EXPIRED ledger entries
 * - Server-authoritative redemption validation
 * - Strict anti-fraud & idempotency keys
 */

export const LOYALTY_TIERS = {
  STANDARD: { name: 'Standard', minPoints: 0, perkMultiplier: 1.0, discountCapPaise: 50000 },
  SILVER: { name: 'Silver', minPoints: 500, perkMultiplier: 1.1, discountCapPaise: 100000 },
  GOLD: { name: 'Gold', minPoints: 1500, perkMultiplier: 1.25, discountCapPaise: 250000 },
  PLATINUM: { name: 'Platinum', minPoints: 3000, perkMultiplier: 1.5, discountCapPaise: 500000 }
};

export const TRANSACTION_TYPES = {
  EARNED: 'EARNED',
  REDEEMED: 'REDEEMED',
  EXPIRED: 'EXPIRED',
  REVERSED: 'REVERSED',
  BONUS: 'BONUS',
  ADJUSTMENT: 'ADJUSTMENT'
};

// In-memory ledger storage (synced with DB)
const loyaltyLedger = [];
const customerAccounts = new Map();

/**
 * Calculates current tier based on lifetime points
 */
export function determineTier(lifetimePoints) {
  if (lifetimePoints >= LOYALTY_TIERS.PLATINUM.minPoints) return 'PLATINUM';
  if (lifetimePoints >= LOYALTY_TIERS.GOLD.minPoints) return 'GOLD';
  if (lifetimePoints >= LOYALTY_TIERS.SILVER.minPoints) return 'SILVER';
  return 'STANDARD';
}

/**
 * Retrieves or initializes customer loyalty profile
 */
export function getCustomerLoyalty(customerId) {
  if (!customerId) throw new Error('LOYALTY_ERROR: Customer ID required');

  let account = customerAccounts.get(customerId);
  if (!account) {
    account = {
      customerId,
      pointsBalance: 0,
      lifetimePoints: 0,
      redeemedPoints: 0,
      tier: 'STANDARD',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    customerAccounts.set(customerId, account);
  }
  return { ...account };
}

/**
 * Retrieves transaction history for customer
 */
export function getLoyaltyLedger(customerId) {
  return loyaltyLedger.filter(tx => tx.customerId === customerId);
}

/**
 * Awards points on completed booking (Idempotent by bookingId)
 */
export function awardBookingPoints({ customerId, bookingId, totalEventValueINR, isRepeatBooking = false }) {
  if (!customerId || !bookingId) throw new Error('LOYALTY_ERROR: customerId and bookingId required');

  // Idempotency check: Ensure booking hasn't already been awarded
  const existing = loyaltyLedger.find(tx => tx.bookingId === bookingId && tx.type === TRANSACTION_TYPES.EARNED);
  if (existing) {
    return { alreadyAwarded: true, transaction: existing, account: getCustomerLoyalty(customerId) };
  }

  const account = getCustomerLoyalty(customerId);
  const tierConfig = LOYALTY_TIERS[account.tier] || LOYALTY_TIERS.STANDARD;

  // Base rule: 1 point per ₹100 spent, scaled by tier multiplier
  const basePoints = Math.floor((totalEventValueINR || 0) / 100);
  let earnedPoints = Math.floor(basePoints * tierConfig.perkMultiplier);

  // Bonus for repeat booking
  if (isRepeatBooking) {
    earnedPoints += 50; // 50 bonus points
  }

  if (earnedPoints <= 0) earnedPoints = 10; // Minimum completion award

  const transaction = {
    transactionId: `tx_loyalty_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    customerId,
    type: TRANSACTION_TYPES.EARNED,
    points: earnedPoints,
    bookingId,
    description: `Points earned from completed event booking #${bookingId}${isRepeatBooking ? ' (Repeat Booking Bonus)' : ''}`,
    createdAt: new Date().toISOString()
  };

  loyaltyLedger.push(transaction);

  // Update account balance
  account.pointsBalance += earnedPoints;
  account.lifetimePoints += earnedPoints;
  account.tier = determineTier(account.lifetimePoints);
  account.updatedAt = new Date().toISOString();
  customerAccounts.set(customerId, account);

  return { success: true, earnedPoints, transaction, account: { ...account } };
}

/**
 * Validates and redeems points for booking discount
 */
export function validateAndRedeemPoints({ customerId, pointsToRedeem, bookingSubtotalPaise, config = {} }) {
  if (!customerId || !pointsToRedeem || pointsToRedeem <= 0) {
    return { valid: false, discountPaise: 0, reason: 'INVALID_POINTS' };
  }

  const account = getCustomerLoyalty(customerId);
  if (account.pointsBalance < pointsToRedeem) {
    return { 
      valid: false, 
      discountPaise: 0, 
      reason: `INSUFFICIENT_POINTS: Available ${account.pointsBalance}, requested ${pointsToRedeem}` 
    };
  }

  // Conversion rule: 100 points = ₹50 discount (50 paise per point)
  const conversionRatePaise = config.paisePerPoint || 50;
  const rawDiscountPaise = pointsToRedeem * conversionRatePaise;

  // Maximum redemption cap (e.g., max 20% of booking subtotal or tier cap)
  const tierConfig = LOYALTY_TIERS[account.tier] || LOYALTY_TIERS.STANDARD;
  const maxPercentCapPaise = Math.round(bookingSubtotalPaise * (config.maxDiscountPercent || 0.20));
  const finalDiscountPaise = Math.min(rawDiscountPaise, maxPercentCapPaise, tierConfig.discountCapPaise);

  if (finalDiscountPaise <= 0) {
    return { valid: false, discountPaise: 0, reason: 'SUBTOTAL_TOO_LOW_FOR_REDEMPTION' };
  }

  const actualPointsUsed = Math.ceil(finalDiscountPaise / conversionRatePaise);

  return {
    valid: true,
    pointsUsed: actualPointsUsed,
    discountPaise: finalDiscountPaise,
    discountINR: finalDiscountPaise / 100,
    remainingBalance: account.pointsBalance - actualPointsUsed
  };
}

/**
 * Commits redemption into the ledger upon payment creation/confirmation
 */
export function commitPointRedemption({ customerId, pointsUsed, bookingId, discountPaise }) {
  const account = getCustomerLoyalty(customerId);
  if (account.pointsBalance < pointsUsed) {
    throw new Error('LOYALTY_ERROR: Insufficient points for ledger debit');
  }

  const transaction = {
    transactionId: `tx_loyalty_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    customerId,
    type: TRANSACTION_TYPES.REDEEMED,
    points: -pointsUsed,
    bookingId,
    description: `Redeemed ${pointsUsed} points for ₹${discountPaise / 100} discount on booking #${bookingId}`,
    createdAt: new Date().toISOString()
  };

  loyaltyLedger.push(transaction);
  account.pointsBalance -= pointsUsed;
  account.redeemedPoints += pointsUsed;
  account.updatedAt = new Date().toISOString();
  customerAccounts.set(customerId, account);

  return { success: true, transaction, account: { ...account } };
}

/**
 * Reverses loyalty points if booking was cancelled/refunded
 */
export function reverseBookingPoints({ customerId, bookingId, reason = 'BOOKING_CANCELLED' }) {
  const account = getCustomerLoyalty(customerId);
  const earnedTx = loyaltyLedger.find(tx => tx.bookingId === bookingId && tx.type === TRANSACTION_TYPES.EARNED);

  if (!earnedTx) {
    return { reversed: false, message: 'No earned points found for booking' };
  }

  // Check if already reversed
  const alreadyReversed = loyaltyLedger.some(tx => tx.bookingId === bookingId && tx.type === TRANSACTION_TYPES.REVERSED);
  if (alreadyReversed) {
    return { alreadyReversed: true, message: 'Points already reversed for this booking' };
  }

  const pointsToReverse = earnedTx.points;
  const transaction = {
    transactionId: `tx_loyalty_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    customerId,
    type: TRANSACTION_TYPES.REVERSED,
    points: -pointsToReverse,
    bookingId,
    description: `Reversal of ${pointsToReverse} points due to ${reason} for booking #${bookingId}`,
    createdAt: new Date().toISOString()
  };

  loyaltyLedger.push(transaction);
  account.pointsBalance = Math.max(0, account.pointsBalance - pointsToReverse);
  account.lifetimePoints = Math.max(0, account.lifetimePoints - pointsToReverse);
  account.tier = determineTier(account.lifetimePoints);
  account.updatedAt = new Date().toISOString();
  customerAccounts.set(customerId, account);

  return { success: true, reversedPoints: pointsToReverse, transaction, account: { ...account } };
}

/**
 * Runs scheduled point expiration job
 */
export function processPointExpirations({ expirationDays = 365, customerId = null } = {}) {
  const cutoffTime = Date.now() - (expirationDays * 24 * 60 * 60 * 1000);
  let expiredCount = 0;
  let totalPointsExpired = 0;

  // Audit transactions older than cutoff that haven't expired
  const accountsToAudit = customerId ? [getCustomerLoyalty(customerId)] : Array.from(customerAccounts.values());

  for (const account of accountsToAudit) {
    // Look for unredeemed earned points
    const earnedTxs = loyaltyLedger.filter(tx => 
      tx.customerId === account.customerId && 
      tx.type === TRANSACTION_TYPES.EARNED && 
      new Date(tx.createdAt).getTime() <= cutoffTime
    );

    for (const tx of earnedTxs) {
      const alreadyExpired = loyaltyLedger.some(e => e.bookingId === tx.bookingId && e.type === TRANSACTION_TYPES.EXPIRED);
      if (!alreadyExpired && account.pointsBalance > 0) {
        const expireAmount = Math.min(tx.points, account.pointsBalance);
        if (expireAmount > 0) {
          const expireTx = {
            transactionId: `tx_loyalty_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            customerId: account.customerId,
            type: TRANSACTION_TYPES.EXPIRED,
            points: -expireAmount,
            bookingId: tx.bookingId,
            description: `Expired ${expireAmount} unredeemed points older than ${expirationDays} days`,
            createdAt: new Date().toISOString()
          };
          loyaltyLedger.push(expireTx);
          account.pointsBalance -= expireAmount;
          account.updatedAt = new Date().toISOString();
          customerAccounts.set(account.customerId, account);
          expiredCount++;
          totalPointsExpired += expireAmount;
        }
      }
    }
  }

  return { expiredCount, totalPointsExpired };
}

/**
 * Resets state for unit testing
 */
export function _resetLoyaltyState() {
  loyaltyLedger.length = 0;
  customerAccounts.clear();
}
