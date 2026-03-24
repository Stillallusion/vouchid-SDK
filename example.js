/**
 * AgentID SDK — Usage Example
 *
 * Run:  ORG_API_KEY=your_key node example.js
 */

import { AgentID, AgentIDError } from "./index.js";

const agentid = new AgentID({
  apiUrl: process.env.AGENTID_API_URL ?? "http://localhost:4000",
  apiKey: process.env.AGENTID_API_KEY,
  refreshThresholdDays: 7,
});

async function main() {
  console.log("=== AgentID SDK Example ===\n");

  // ── 1. Register a new agent ─────────────────────────────────────────────
  console.log("1. Registering agent...");
  const agent = await agentid.register({
    name:         "sdk-test-bot",
    capabilities: ["read:data", "write:reports"],
    model:        "gpt-4o",
  });

  console.log(`   Agent ID:    ${agent.agentId}`);
  console.log(`   Trust level: ${agent.trustLevel}`);
  console.log(`   Expires:     ${agent.expiresAt}\n`); // uses public getter

  // ── 2. Get token (auto-refreshes if < 7 days remaining) ─────────────────
  console.log("2. Getting token...");
  const token = await agent.getToken();
  console.log(`   Acquired token (${token.length} chars)\n`); // no token content logged

  // ── 3. Verify the agent ─────────────────────────────────────────────────
  console.log("3. Verifying agent...");
  const result = await agent.verify(["read:data"]);
  console.log(`   Valid:       ${result.valid}`);
  console.log(`   Trust score: ${result.trust_score}`);
  console.log(`   Trust level: ${result.trust_level}\n`);

  // ── 4. Check permission ─────────────────────────────────────────────────
  console.log("4. Checking permission for write:reports...");
  const permission = await agent.checkPermission("write:reports", { amount: 0 });
  console.log(`   Allowed: ${permission.allowed}\n`);

  // ── 5. Get reputation ───────────────────────────────────────────────────
  console.log("5. Getting reputation...");
  const rep = await agent.getReputation();
  console.log(`   Score:         ${rep.trustScore}`);
  console.log(`   Verifications: ${rep.totalVerifications}`);
  console.log(`   Success rate:  ${rep.successRate}%\n`);

  // ── 6. Serialize for storage ────────────────────────────────────────────
  console.log("6. Serializing agent for storage...");
  const stored = agent.toJSON();
  console.log(`   Keys: ${Object.keys(stored).join(", ")}\n`);

  // ── 7. Restore from storage ─────────────────────────────────────────────
  console.log("7. Restoring agent from storage...");
  const restored     = agentid.loadAgent(stored);
  const restoredToken = await restored.getToken();
  console.log(`   Token matches: ${restoredToken === token}\n`);

  console.log("=== All done ===");
}

main().catch((err) => {
  if (err instanceof AgentIDError) {
    console.error(`AgentID error [${err.code}]: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
