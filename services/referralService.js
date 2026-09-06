/**
 * PARVA PLATFORM — AUTHORITATIVE REFERRAL SYSTEM & ABUSE PROTECTION
 * Version 1.0.0
 * 
 * Rules:
 * - Deterministic referral codes (e.g. PARVA-ABC123) without exposing internal UIDs
 * - Reward awarded ONLY when referee completes eligible first booking (never on signup alone)
 * - Self-referral & duplicate referral prevention
 * - Heuristic fraud & risk scoring for suspicious device / booking clusters
 * - Server-authoritative admin campaign configuration
 */

import crypto from 'crypto';

// In-memory referral mappings
const referralCodes = new Map(); // customerId -> code
const codeOwners = new Map();    // code -> customerId
const referralClaims = [];       // list of referral claims/links
const referralRewards = [];      // auditable rewards log

export const DEFAULT_REFERRAL_CONFIG = {
  enabled: true,
  referrerRewardPoints: 200,      // 200 Loyalty Points for Referrer (₹100 value)
  newCustomerRewardPaise: 50000,  // ₹500 discount for New Customer on First Booking
  minimumBookingValuePaise: 200000, // ₹2,000 minimum booking to trigger reward
  firstBookingOnly: true,
  maxRewardsPerReferrer: 25,
  campaignStart: '2026-01-01T00:00:00Z',
  campaignEnd: '2027-12-31T23:59:59Z'
};

/**
 * Generates or retrieves unique referral code for a customer
 */
export function getOrCreateReferralCode(customerId) {
  if (!customerId) throw new Error('REFERRAL_ERROR: Customer ID required');

  if (referralCodes.has(customerId)) {
    return referralCodes.get(customerId);
  }

  // Generate clean 6-character uppercase alphanumeric code
  const hash = crypto.createHash('sha256').update(customerId).digest('hex').substring(0, 6).toUpperCase();
  const code = `PARVA-${hash}`;

  referralCodes.set(customerId, code);
  codeOwners.set(code, customerId);
  return code;
}

/**
 * Validates a referral code during referee signup / checkout
 */
export function validateReferralCode(code, refereeId, refereeMetadata = {}) {
  if (!DEFAULT_REFERRAL_CONFIG.enabled) {
    return { valid: false, reason: 'REFERRAL_PROGRAM_PAUSED' };
  }

  const cleanCode = (code || '').trim().toUpperCase();
  const referrerId = codeOwners.get(cleanCode);

  if (!referrerId) {
    return { valid: false, reason: 'INVALID_REFERRAL_CODE' };
  }

  // Anti-fraud check 1: Self-referral
  if (referrerId === refereeId) {
    return { 
      valid: false, 
      reason: 'SELF_REFERRAL_FORBIDDEN', 
      riskScore: 90, 
      message: 'You cannot use your own referral code' 
    };
  }

  // Anti-fraud check 2: Duplicate referral claim by same referee
  const existingClaim = referralClaims.find(c => c.refereeId === refereeId);
  if (existingClaim) {
    return { 
      valid: false, 
      reason: 'REFERRAL_ALREADY_CLAIMED', 
      message: 'You have already applied a referral code' 
    };
  }

  // Anti-fraud check 3: Same device / IP / Phone cluster check
  let riskScore = 0;
  const riskReasons = [];

  if (refereeMetadata.deviceId && refereeMetadata.referrerDeviceId === refereeMetadata.deviceId) {
    riskScore += 60;
    riskReasons.push('SAME_DEVICE_DETECTED');
  }

  if (refereeMetadata.phone && refereeMetadata.referrerPhone === refereeMetadata.phone) {
    riskScore += 80;
    riskReasons.push('MATCHING_PHONE_NUMBER');
  }

  // Anti-fraud check 4: Referrer reward limit
  const referrerRewardCount = referralRewards.filter(r => r.referrerId === referrerId && r.status === 'AWARDED').length;
  if (referrerRewardCount >= DEFAULT_REFERRAL_CONFIG.maxRewardsPerReferrer) {
    return { valid: false, reason: 'REFERRER_LIMIT_REACHED' };
  }

  return {
    valid: true,
    code: cleanCode,
    referrerId,
    refereeId,
    rewardDiscountPaise: DEFAULT_REFERRAL_CONFIG.newCustomerRewardPaise,
    riskScore,
    riskReasons,
    adminReviewRequired: riskScore >= 50
  };
}

/**
 * Registers an initial referral association when customer B signs up or applies code
 */
export function registerReferralClaim({ code, refereeId, metadata = {} }) {
  const validation = validateReferralCode(code, refereeId, metadata);
  if (!validation.valid) {
    throw new Error(`REFERRAL_ERROR: ${validation.reason}`);
  }

  const claim = {
    claimId: `ref_claim_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    code: validation.code,
    referrerId: validation.referrerId,
    refereeId,
    status: validation.adminReviewRequired ? 'PENDING_REVIEW' : 'REGISTERED',
    riskScore: validation.riskScore,
    riskReasons: validation.riskReasons,
    createdAt: new Date().toISOString()
  };

  referralClaims.push(claim);
  return claim;
}

/**
 * Evaluates and awards referral rewards when referee's booking reaches COMPLETED
 */
export function processReferralBookingCompletion({ refereeId, bookingId, totalEventValuePaise }) {
  const claim = referralClaims.find(c => c.refereeId === refereeId && (c.status === 'REGISTERED' || c.status === 'PENDING_REVIEW'));
  if (!claim) {
    return { eligible: false, reason: 'NO_ACTIVE_REFERRAL_CLAIM' };
  }

  if (claim.status === 'PENDING_REVIEW') {
    return { eligible: false, reason: 'HELD_FOR_ADMIN_FRAUD_REVIEW', claimId: claim.claimId };
  }

  // Verify minimum booking value
  if (totalEventValuePaise < DEFAULT_REFERRAL_CONFIG.minimumBookingValuePaise) {
    return { 
      eligible: false, 
      reason: 'MINIMUM_BOOKING_VALUE_NOT_MET',
      required: DEFAULT_REFERRAL_CONFIG.minimumBookingValuePaise,
      actual: totalEventValuePaise
    };
  }

  // Verify idempotency
  const alreadyAwarded = referralRewards.some(r => r.bookingId === bookingId);
  if (alreadyAwarded) {
    return { eligible: false, reason: 'REWARD_ALREADY_PROCESSED' };
  }

  const rewardRecord = {
    rewardId: `ref_rew_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    claimId: claim.claimId,
    referrerId: claim.referrerId,
    refereeId: claim.refereeId,
    bookingId,
    referrerRewardPoints: DEFAULT_REFERRAL_CONFIG.referrerRewardPoints,
    newCustomerRewardPaise: DEFAULT_REFERRAL_CONFIG.newCustomerRewardPaise,
    status: 'AWARDED',
    awardedAt: new Date().toISOString()
  };

  referralRewards.push(rewardRecord);
  claim.status = 'COMPLETED';
  claim.completedAt = new Date().toISOString();

  return {
    eligible: true,
    reward: rewardRecord,
    referrerPointsToAward: DEFAULT_REFERRAL_CONFIG.referrerRewardPoints
  };
}

/**
 * Reverses referral reward if referee booking is refunded/cancelled
 */
export function reverseReferralReward({ bookingId, reason = 'BOOKING_CANCELLED' }) {
  const reward = referralRewards.find(r => r.bookingId === bookingId && r.status === 'AWARDED');
  if (!reward) {
    return { reversed: false, message: 'No referral reward found for booking' };
  }

  reward.status = 'REVERSED';
  reward.reversedAt = new Date().toISOString();
  reward.reversalReason = reason;

  return {
    reversed: true,
    reward,
    referrerPointsToDeduct: reward.referrerRewardPoints
  };
}

/**
 * Resets state for testing
 */
export function _resetReferralState() {
  referralCodes.clear();
  codeOwners.clear();
  referralClaims.length = 0;
  referralRewards.length = 0;
}
