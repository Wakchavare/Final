const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function loadEnv() {
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, "..", "..", "deployment", ".env")
  ].filter(Boolean);

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

module.exports = { loadEnv };
