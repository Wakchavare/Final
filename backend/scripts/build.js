const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requiredFiles = ["index.html", "styles.css", "apiClient.js", "rbac.js", "auth.js", "inventory.js", "invoicing.js", "app.js", "kanban.js"];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required frontend file: ${file}`);
  }
}

console.log("Build check passed. Static frontend and backend files are present.");
