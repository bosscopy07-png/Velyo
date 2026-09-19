import { blockchain } from '../src/services/blockchain';

const address = '0x5d9CF77d50B183C7e1BA29478901Cc7348fd6072';

(async () => {
  const raw = await blockchain.getBalance(address, 'USDT');

  console.log('Wallet:', address);
  console.log('Raw USDT:', raw);
  console.log('Converted:', Number(raw) / 1e18);

  process.exit(0);
})();
