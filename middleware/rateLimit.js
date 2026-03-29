function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter(options = {}) {
  const {
    windowMs = 60_000,
    maxRequests = 120,
    keyGenerator = getClientIp,
    skip = () => false,
    name = 'rate-limit',
  } = options;

  const buckets = new Map();

  return function rateLimitMiddleware(req, res, next) {
    if (skip(req)) return next();

    const now = Date.now();
    const key = `${name}:${keyGenerator(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('x-ratelimit-limit', String(maxRequests));
      res.setHeader('x-ratelimit-remaining', String(Math.max(0, maxRequests - 1)));
      res.setHeader('x-ratelimit-reset', String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }

    current.count += 1;
    const remaining = Math.max(0, maxRequests - current.count);
    res.setHeader('x-ratelimit-limit', String(maxRequests));
    res.setHeader('x-ratelimit-remaining', String(remaining));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(current.resetAt / 1000)));

    if (current.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('retry-after', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
        requestId: req.requestId,
      });
    }

    return next();
  };
}

module.exports = {
  createRateLimiter,
};
