import { config } from '../config';
import { redis } from './redis';
import { logger } from '../utils/logger';

interface PriceCache {
  usd: number;
  ngn: number;
  timestamp: number;
}

class PricingService {
  private readonly CACHE_TTL = 300; // 5 minutes

  async getPrice(asset: string): Promise<PriceCache> {
    const cacheKey = `price:${asset.toLowerCase()}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      const data: PriceCache = JSON.parse(cached);
      if (Date.now() - data.timestamp < this.CACHE_TTL * 1000) {
        return data;
      }
    }
    
    try {
      // Fetch USD price from CoinGecko
      const cgResponse = await fetch(
        `${config.PRICE_API_URL}/simple/price?ids=${this.getCoinGeckoId(asset)}&vs_currencies=usd`
      );
      const cgData = await cgResponse.json();
      const usdPrice = cgData[this.getCoinGeckoId(asset)]?.usd || 0;
      
      // Fetch NGN rate
      const ngnResponse = await fetch(config.NGN_RATE_API_URL);
      const ngnData = await ngnResponse.json();
      const ngnRate = ngnData.rates?.NGN || 0;
      
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
      if (cached) return JSON.parse(cached);
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
