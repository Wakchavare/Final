require("dotenv").config();
const { dbFile, runSqlFile } = require("./db");

async function migrate() {
  await runSqlFile(dbFile("schema.sql"));
  console.log("Database schema migrated.");
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { migrate };
