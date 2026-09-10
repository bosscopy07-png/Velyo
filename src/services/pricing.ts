import { config } from '../config';
import { redis } from './redis';
import { logger } from '../utils/logger';

interface PriceCache {
  usd: number;
  ngn: number;
  timestamp: number;
}

/** Shape of the CoinGecko /simple/price response for the fields we consume. */
interface CoinGeckoSimplePriceResponse {
  [coinId: string]: {
    usd?: number;
    // other vs_currencies would appear here if requested
  } | undefined;
}

/** Shape of the exchange-rate API response for the fields we consume. */
interface ExchangeRatesResponse {
  rates?: {
    NGN?: number;
    [currency: string]: number | undefined;
  };
}

class PricingService {
  private readonly CACHE_TTL = 300; // 5 minutes

  async getPrice(asset: string): Promise<PriceCache> {
    const cacheKey = `price:${asset.toLowerCase()}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      try {
        const data = JSON.parse(cached) as PriceCache;
        if (Date.now() - data.timestamp < this.CACHE_TTL * 1000) {
          return data;
        }
      } catch {
        // Corrupted cache entry — fall through and refetch.
      }
    }

    try {
      const coinId = this.getCoinGeckoId(asset);

      // Fetch USD price from CoinGecko
      const cgResponse = await fetch(
        `${config.PRICE_API_URL}/simple/price?ids=${coinId}&vs_currencies=usd`
      );
      if (!cgResponse.ok) {
        throw new Error(`CoinGecko request failed with ${cgResponse.status}`);
      }
      const cgData = (await cgResponse.json()) as CoinGeckoSimplePriceResponse;
      const usdPrice = cgData[coinId]?.usd ?? 0;
      if (!usdPrice) {
        throw new Error(`No USD price returned for ${asset} (${coinId})`);
      }

      // Fetch NGN rate
      const ngnResponse = await fetch(config.NGN_RATE_API_URL);
      if (!ngnResponse.ok) {
        throw new Error(`NGN rate request failed with ${ngnResponse.status}`);
      }
      const ngnData = (await ngnResponse.json()) as ExchangeRatesResponse;
      const ngnRate = ngnData.rates?.NGN ?? 0;
      if (!ngnRate) {
        throw new Error('No NGN rate returned by exchange-rate API');
      }

      const result: PriceCache = {
        usd: usdPrice,
        ngn: usdPrice * ngnRate,
        timestamp: Date.now(),
      };

      await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(result));
      return result;
    } catch (err) {
      logger.error('Price fetch error:', err);
      // Return stale cache if available
      if (cached) {
        try {
          return JSON.parse(cached) as PriceCache;
        } catch {
          // fall through
        }
      }
      return { usd: 0, ngn: 0, timestamp: Date.now() };
    }
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

  private getCoinGeckoId(asset: string): string {
    const map: Record<string, string> = {
      BNB: 'binancecoin',
      USDT: 'tether',
      BTC: 'bitcoin',
      ETH: 'ethereum',
      SOL: 'solana',
      TON: 'the-open-network',
      USDC: 'usd-coin',
    };
    return map[asset.toUpperCase()] || asset.toLowerCase();
  }
}

export const pricing = new PricingService();
  
