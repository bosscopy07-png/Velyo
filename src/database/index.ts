import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('query', (e) => {
  if (process.env.LOG_QUERIES === 'true') {
    logger.debug('Query:', { query: e.query, duration: e.duration });
  }
});

prisma.$on('error', (e) => {
  logger.error('Prisma error:', e);
});
