import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

const candidates = [
  join(process.cwd(), ".env"),
  join(process.cwd(), "..", ".env"),
];

for (const envPath of candidates) {
  if (existsSync(envPath)) {
    config({ path: envPath, quiet: true });
    break;
  }
}

// Apply credential-file fallbacks to the environment (files only fill
// variables that are unset/empty; real env always wins).
import { seedCredentialEnv } from "../services/freelance/credentials";

seedCredentialEnv();
