import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'veylo-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Never log sensitive data
export function sanitizeLog(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  
  const sensitive = ['privateKey', 'mnemonic', 'seed', 'password', 'secret', 'apiKey'];
  const sanitized = { ...obj as Record<string, unknown> };
  
  for (const key of Object.keys(sanitized)) {
    if (sensitive.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeLog(sanitized[key]);
    }
  }
  
  return sanitized;
}
