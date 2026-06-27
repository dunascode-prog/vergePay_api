import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import initDB from "./db/initDB.js";

dotenv.config();

// try {
//   await initDB();
//   console.log("DB connection successfull");
// } catch (err) {
//   console.log(err);
// }

const app = express();
app.use(express.json());

app.listen(process.env.SERVER_PORT, () => {
  console.log(`server listening at port ${process.env.SERVER_PORT}...`);
});
