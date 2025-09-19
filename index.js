const express = require("express");
const redis = require("redis");
require("dotenv").config();
const app = express();
const PORT = process.env.PORT;

const client = redis.createClient();
client.on("error", (err) => {
  console.log("Redis Error: ", err);
});
const rateLimiter = (limit, windowSec) => {
  return async (req, res, next) => {
    try {
      const ip = req.ip;
      const key = `rate_limit:${ip}`;
      const requests = await client.incr(key);
      if (requests === 1) {
        await client.expire(key, windowSec);
      }
      if (requests > limit) {
        res.set("Retry-After", windowSec);
        return res.status(429).send("Too Many Requests!! try again later.");
      }
      res.set("X-RateLimit-Limit", limit);

      res.set("X-RateLimit-Remaining", Math.max(0, limit - requests));
      next();
    } catch (err) {
      console.error("Rate limiter error:", err);
      res.status(500).send("Internal Server Error");
    }
  };
};
const slidingwindow = (limit, windowSec) => {
  return async (req, res, next) => {
    try {
      const ip = req.ip;
      const now = Math.floor(Date.now() / 1000);
      const windowStart = Math.floor(now / windowSec) * windowSec;

      const currKey = `rate:${ip}:${windowStart}`;
      const prevKey = `rate:${ip}:${windowStart - windowSec}`;
      const currCount = await client.incr(currKey);
      if (currCount === 1) await client.expire(currKey, windowSec * 2);

      const prevCount = parseInt(await client.get(prevKey)) || 0;

      const elapsed = now - windowStart;
      const weight = (windowSec - elapsed) / windowSec;

      const total = currCount + prevCount * weight;

      if (total > limit) {
        return res.status(429).send("Too Many Requests (Sliding Window)");
      }

      next();
    } catch {
      console.error("Limiter error:", err);
      res.status(500).send("Internal Error");
    }
  };
};
(async () => {
  try {
    await client.connect();
    console.log("Connected to Redis");
    app.use(rateLimiter(5, 10));

    app.get("/", (req, res) => {
      res.send("Hello!!!");
    });

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Could not connect to Redis:", err);
    process.exit(1);
  }
})();
