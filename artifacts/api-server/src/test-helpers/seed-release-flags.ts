import { pool } from "@workspace/db";
import { seedReleaseFlags } from "../bootstrap/seed.ts";

try {
  await seedReleaseFlags();
} finally {
  await pool.end();
}
