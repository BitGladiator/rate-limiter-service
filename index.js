const express = require("express");
const redis = require("redis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json()); // Parse JSON bodies

const client = redis.createClient();
client.on("error", (err) => {
  console.log("Redis Error: ", err);
});

// Request counter middleware
let totalRequests = 0;
app.use((req, res, next) => {
  totalRequests++;
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
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
        return res.status(429).send("Too Many Requests");
      }
      
      res.set("X-RateLimit-Remaining", Math.max(0, limit - requests));
      next();
    } catch (err) {
      console.error("Rate limiter error:", err);
      res.status(500).send("Internal Server Error");
    }
  };
};

const slidingWindowLimiter = (limit, windowSec) => {
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
      
      const remaining = Math.max(0, limit - total);
      const resetTime = windowStart + windowSec;
      
      res.set("X-RateLimit-Limit", limit);
      res.set("X-RateLimit-Remaining", Math.floor(remaining));
      res.set("X-RateLimit-Reset", resetTime);
      
      if (total > limit) {
        return res.status(429).send("Too Many Requests (Sliding Window)");
      }
      
      next();
    } catch (err) {
      console.error("Limiter error:", err);
      res.status(500).send("Internal Error");
    }
  };
};

(async () => {
  try {
    await client.connect();
    console.log("Connected to Redis");
    
    app.use(rateLimiter(5, 60));
    
    app.get("/", (req, res) => {
      res.send("Hello!!!");
    });
    
    app.get("/api/data", slidingWindowLimiter(10, 30), (req, res) => {
      res.json({ data: "Some API data", timestamp: Date.now() });
    });
    
    
    app.get("/health", async (req, res) => {
      try {
        await client.ping();
        res.json({ 
          status: "OK", 
          redis: "connected",
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        res.status(503).json({ status: "ERROR", redis: "disconnected" });
      }
    });
    
    app.get("/status", (req, res) => {
      res.json({ status: "OK", server: "running" });
    });
  
    
    // NEW: Server stats
    app.get("/stats", (req, res) => {
      res.json({
        totalRequests,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform
      });
    });
    
    app.get("/reset/:ip", async (req, res) => { //reset the rate limit
      try {
        const ip = req.params.ip;
        const deleted = await client.del(`rate_limit:${ip}`);
        res.json({ message: `Reset rate limit for ${ip}`, deleted });
      } catch (err) {
        res.status(500).send("Error resetting limit");
      }
    });

    app.post("/echo", (req, res) => { //display the request
      res.json({
        method: req.method,
        body: req.body,
        headers: req.headers,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
    });
    app.get("/limits/:ip?", async (req, res) => { //get current rate limit status from the ip
      try {
        const ip = req.params.ip || req.ip;
        const key = `rate_limit:${ip}`;
        const count = await client.get(key);
        const ttl = await client.ttl(key);
        
        res.json({ 
          ip, 
          requests: parseInt(count) || 0, 
          ttl: ttl > 0 ? ttl : null,
          limit: 5,
          window: 60
        });
      } catch (err) {
        res.status(500).send("Error getting limits");
      }
    });
    app.use("*", (req, res) => { //Handling the unknown routes
      res.status(404).json({ 
        error: "Not Found", 
        path: req.path,
        method: req.method 
      });
    });
    
    app.listen(PORT, () => { // Start the server
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Could not connect to Redis:", err);
    process.exit(1);
  }
})();