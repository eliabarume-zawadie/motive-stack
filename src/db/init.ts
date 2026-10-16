import { config as loadEnv } from "dotenv";
import { migrate, openDb } from "./db.js";

loadEnv({ path: ".env.local" });
const path = process.env.DATABASE_PATH ?? "./data/motivestack.db";
const db = openDb(path);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database already up to date.");
console.log(`Database: ${path}`);
db.close();
