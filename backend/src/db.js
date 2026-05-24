const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const connectionString =
  process.env.DATABASE_URL || "postgres://casting_user:casting_password@localhost:5432/casting_production";

const pool = new Pool({ connectionString });

async function query(text, params) {
  return pool.query(text, params);
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function runSqlFile(filePath) {
  const sql = fs.readFileSync(filePath, "utf8");
  await query(sql);
}

function dbFile(name) {
  return path.resolve(__dirname, "..", "db", name);
}

module.exports = { dbFile, pool, query, runSqlFile, transaction };
