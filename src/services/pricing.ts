import { config } from '../config';
import { redis } from './redis';
import { logger } from '../utils/logger';

/** Prices for every supported asset, plus the fetch timestamp. */
interface PriceBundle {
  prices: Record<string, { usd: number; ngn: number }>;
  timestamp: number;
}

interface PriceCache {
  usd: number;
  ngn: number;
  timestamp: number;
}

/** Shape of the CoinGecko /simple/price response for the fields we consume. */
interface CoinGeckoSimplePriceResponse {
  [coinId: string]: {
    usd?: number;
  } | undefined;
}

/** Shape of the exchange-rate API response for the fields we consume. */
interface ExchangeRatesResponse {
  rates?: {
    NGN?: number;
    [currency: string]: number | undefined;
  };
}

const BUNDLE_CACHE_KEY = 'price:fx';
const INFLIGHT_KEY = 'all';

class PricingService {
  private readonly CACHE_TTL = 600; // 10 minutes

  // Demo API key lives in env — never hardcode secrets in source.
  private readonly COINGECKO_API_KEY = config.COINGECKO_API_KEY;

  /** CoinGecko demo keys go in this header; `x_cg_pro_api_key` only works for paid Pro keys. */
  private readonly COINGECKO_HEADERS: Record<string, string> = this.COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': this.COINGECKO_API_KEY }
    : {};

  /** In-flight lock so concurrent callers share ONE request (prevents cache stampede). */
  private inflight = new Map<string, Promise<PriceBundle>>();

  async getPrice(asset: string): Promise<PriceCache> {
    // 1) Fresh cache hit?
    const cached = await this.getFreshBundle();
    const hit = cached?.prices[this.getCoinGeckoId(asset)];
    if (hit) {
      return { ...hit, timestamp: cached!.timestamp };
    }

    // 2) Already fetching? Join that request instead of starting a new one.
    const pending = this.inflight.get(INFLIGHT_KEY);
    const bundle = pending ? await pending : await this.fetchBundleWithLock();

    // 3) Serve from the fresh bundle; fall back to stale cache on failure.
    const price = bundle.prices[this.getCoinGeckoId(asset)];
    if (price) {
      return { ...price, timestamp: bundle.timestamp };
    }
    const stale = await this.getBundle(); // may be stale but better than zeros
    const stalePrice = stale?.prices[this.getCoinGeckoId(asset)];
    if (stalePrice) {
      return { ...stalePrice, timestamp: stale!.timestamp };
    }
    return { usd: 0, ngn: 0, timestamp: Date.now() };
  }

  async convertToUSD(asset: string, amount: number): Promise<number> {
    const price = await this.getPrice(asset);
    return amount * price.usd;
  }

  async convertToNGN(asset: string, amount: number): Promise<number> {
    const price = await this.getPrice(asset);
    return amount * price.ngn;
  }

  formatNGN(amount: number): string {
    return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  formatUSD(amount: number): string {
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // ─────────────────────────── internals ───────────────────────────

  /** Register the fetch under the lock; only one caller actually hits the APIs. */
  private async fetchBundleWithLock(): Promise<PriceBundle> {
    const request = this.fetchBundle();
    this.inflight.set(INFLIGHT_KEY, request);
    try {
      return await request;
    } finally {
      this.inflight.delete(INFLIGHT_KEY);
    }
  }

  /** Fetch CoinGecko + NGN rate, cache the bundle, tolerate failures. */
  private async fetchBundle(): Promise<PriceBundle> {
    try {
      const coinIds = Object.values(this.COIN_ID_MAP).join(',');

      const cgUrl = `${config.PRICE_API_URL}/simple/price?ids=${coinIds}&vs_currencies=usd`;
      const cgResponse = await this.fetchWithRetry(cgUrl, {
        headers: this.COINGECKO_HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (!cgResponse.ok) {
        throw new Error(`CoinGecko request failed with ${cgResponse.status}`);
      }
      const cgData = (await cgResponse.json()) as CoinGeckoSimplePriceResponse;

      const ngnResponse = await this.fetchWithRetry(config.NGN_RATE_API_URL, {
        signal: AbortSignal.timeout(5000),
      });
      if (!ngnResponse.ok) {
        throw new Error(`NGN rate request failed with ${ngnResponse.status}`);
      }
      const ngnData = (await ngnResponse.json()) as ExchangeRatesResponse;
      const ngnRate = ngnData.rates?.NGN ?? 0;
      if (!ngnRate) {
        throw new Error('No NGN rate returned by exchange-rate API');
      }

      const prices: PriceBundle['prices'] = {};
      for (const coinId of Object.values(this.COIN_ID_MAP)) {
        const usd = cgData[coinId]?.usd ?? 0;
        if (!usd) {
          logger.warn(`No USD price returned for coin id "${coinId}" — skipping`);
          continue;
        }
        prices[coinId] = { usd, ngn: usd * ngnRate };
      }

      const bundle: PriceBundle = { prices, timestamp: Date.now() };
      await this.setBundle(bundle);
      return bundle;
    } catch (err) {
      logger.error('Price fetch error:', err);
      // Return whatever stale bundle we have so callers still get numbers.
      const stale = await this.getBundle();
      return stale ?? { prices: {}, timestamp: Date.now() };
    }
  }

  /** GET with short exponential backoff — 429s are transient, retry before giving up. */
  private async fetchWithRetry(url: string, opts: RequestInit, retries = 2): Promise<Response> {
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, opts);
      if (res.ok || res.status !== 429) return res;
      lastResponse = res;
      const waitMs = 500 * (attempt + 1); // 500ms, then 1s
      logger.warn(`Rate limited (429) on ${url}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return lastResponse!;
  }

  // ─────────────────────────── redis helpers ───────────────────────────

  private async getBundle(): Promise<PriceBundle | null> {
    try {
      const raw = await redis.get(BUNDLE_CACHE_KEY);
      return raw ? (JSON.parse(raw) as PriceBundle) : null;
    } catch {
      return null; // redis down or corrupted entry — treat as miss
    }
  }

  /** Cache hit only if the bundle is younger than CACHE_TTL. */
  private async getFreshBundle(): Promise<PriceBundle | null> {
    const bundle = await this.getBundle();
    if (bundle && Date.now() - bundle.timestamp < this.CACHE_TTL * 1000) {
      return bundle;
    }
    return null;
  }

  private async setBundle(bundle: PriceBundle): Promise<void> {
    try {
      await redis.setex(BUNDLE_CACHE_KEY, this.CACHE_TTL, JSON.stringify(bundle));
    } catch (err) {
      logger.warn('Failed to write price cache to redis:', err);
    }
  }

  // ─────────────────────────── asset mapping ───────────────────────────

  private readonly COIN_ID_MAP: Record<string, string> = {
    BNB: 'binancecoin',
    USDT: 'tether',
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    TON: 'the-open-network',
    USDC: 'usd-coin',
  };

  private getCoinGeckoId(asset: string): string {
    return this.COIN_ID_MAP[asset.toUpperCase()] || asset.toLowerCase();
  }
}

export const pricing = new PricingService();
