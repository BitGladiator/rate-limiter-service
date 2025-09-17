const express = require("express")
const redis = require("redis");
require("dotenv").config();
const app = express();
const PORT = process.env.PORT;

const client = redis.createClient();
client.on("error",(err)=>{
    console.log("Redis Error: ",err);
})
app.get('/',(req,res)=>{
    res.send("Hello!!!");
})
app.listen(PORT,()=>{
   console.log(`Server running on port ${PORT}`);
})