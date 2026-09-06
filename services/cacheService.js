/**
 * PARVA CACHE SERVICE
 * Scalable in-memory caching with TTL, LRU-like eviction, and safe invalidation hooks.
 * 
 * Rules:
 * - SAFE TO CACHE: Public categories, active vendor profiles, service metadata, public promotions.
 * - STRICTLY NON-CACHEABLE: Real-time availability, 15-minute slot holds, payment orders, booking state transitions.
 */

export class CacheService {
  constructor(defaultTtlSeconds = 300, maxEntries = 1000) {
    this.cache = new Map();
    this.defaultTtl = defaultTtlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0
    };
  }

  /**
   * Generates a standardized cache key
   */
  generateKey(namespace, identifier) {
    return `${namespace}:${identifier}`;
  }

  /**
   * Retrieves an item from cache if valid and not expired
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    // Refresh access order for LRU-like behavior
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /**
   * Sets an item in cache with explicit TTL
   */
  set(key, value, ttlSeconds = null) {
    if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    const ttlMs = (ttlSeconds ? ttlSeconds * 1000 : this.defaultTtl);
    const entry = {
      value,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now()
    };

    this.cache.set(key, entry);
    this.stats.sets++;
    return true;
  }

  /**
   * Invalidates a specific key
   */
  invalidate(key) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.stats.invalidations++;
      return true;
    }
    return false;
  }

  /**
   * Invalidates all keys matching a namespace prefix
   */
  invalidateNamespace(namespace) {
    let count = 0;
    const prefix = `${namespace}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    this.stats.invalidations += count;
    return count;
  }

  /**
   * Specific invalidation hooks for domain entities
   */
  invalidateVendorCache(vendorId) {
    this.invalidate(`vendor:${vendorId}`);
    this.invalidateNamespace('vendors_list');
  }

  invalidateCategoryCache() {
    this.invalidateNamespace('categories');
  }

  invalidatePromotionCache() {
    this.invalidateNamespace('promotions');
  }

  /**
   * Returns cache runtime health and performance metrics
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? ((this.stats.hits / totalRequests) * 100).toFixed(2) : '0.00';
    return {
      ...this.stats,
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hitRate: `${hitRate}%`
    };
  }

  /**
   * Clears entire cache (used in test resets)
   */
  clear() {
    this.cache.clear();
  }
}

export const cacheService = new CacheService();
export default cacheService;
