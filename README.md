# @vouchid/sdk

Register AI agents, manage tokens with automatic refresh, and verify identities against your VouchID backend.

```
npm install @vouchid/sdk
```

Node.js 18+ required. ESM only (`"type": "module"` in your `package.json`).

---

## Quick start

```js
import { AgentID } from "@vouchid/sdk";

const vouchid = new AgentID({
  apiUrl: process.env.VOUCHID_API_URL,
  apiKey: process.env.VOUCHID_API_KEY,
});

// Register an agent and declare its capabilities
const agent = await vouchid.register({
  name: "data-pipeline-bot",
  capabilities: ["read:data", "write:reports"],
  model: "gpt-4o", // optional
});

// Get a token — automatically refreshes when nearing expiry
const token = await agent.getToken();
```

---

## Core concepts

### Registration vs loading

Call `register()` once when your agent is first created. For subsequent runs, persist the agent state with `toJSON()` and restore it with `loadAgent()` — this avoids creating a new agent identity on every startup.

```js
// First run — register and persist
const agent = await vouchid.register({
  name: "my-bot",
  capabilities: ["read:data"],
});

// Save to your database, a file, an env var, etc.
await db.save("agent", agent.toJSON());

// Later runs — restore from persisted state
const saved = await db.load("agent");
const agent = vouchid.loadAgent(saved);

// getToken() still auto-refreshes even on a restored agent
const token = await agent.getToken();
```

### Token lifecycle

Tokens are long-lived by default. `getToken()` checks expiry automatically and refreshes the token if it will expire within the next 7 days (configurable via `refreshThresholdDays`). You can call `getToken()` on every request without worrying about expiry.

```js
// Safe to call on every MCP tool call — refreshes transparently
const token = await agent.getToken();
```

---

## API reference

### `new AgentID(options)`

| Option                 | Type           | Default   | Description                                                                  |
| ---------------------- | -------------- | --------- | ---------------------------------------------------------------------------- |
| `apiUrl`               | `string`       | —         | **Required.** Your VouchID backend URL.                                      |
| `apiKey`               | `string`       | —         | **Required.** Your org API key.                                              |
| `refreshThresholdDays` | `number`       | `7`       | Days before expiry to auto-refresh the token.                                |
| `timeoutMs`            | `number`       | `10000`   | Request timeout in ms.                                                       |
| `maxRetries`           | `number`       | `3`       | Retry attempts on 429 / 5xx and network errors.                              |
| `logger`               | `object\|null` | `console` | Custom logger with `.info()`, `.warn()`, `.error()`. Pass `null` to silence. |

---

### `agentid.register(params)` → `Promise<AgentClient>`

Register a new agent. Returns an `AgentClient` that manages its token.

```js
const agent = await vouchid.register({
  name: "my-bot", // required, max 128 chars
  capabilities: ["read:filesystem"], // required, non-empty array of "scope:action" strings
  model: "gpt-4o", // optional
});

agent.agentId; // "agent_01jk2m3n4p5q6r7s"
agent.capabilities; // ["read:filesystem"]
agent.trustLevel; // "verified"
```

---

### `agentid.loadAgent(params)` → `AgentClient`

Restore a previously registered agent from serialised state. Use `agent.toJSON()` to obtain the state.

```js
const agent = vouchid.loadAgent({
  agentId: "agent_01jk2m3n4p5q6r7s",
  token: "eyJ...",
  expiresAt: "2025-12-01T00:00:00.000Z",
  capabilities: ["read:filesystem"],
  trustLevel: "verified",
});
```

---

### `AgentClient`

Returned by `register()` and `loadAgent()`.

| Property / method            | Description                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| `agentId`                    | The unique agent ID string.                                   |
| `capabilities`               | Array of capability strings.                                  |
| `trustLevel`                 | Current trust level.                                          |
| `expiresAt`                  | ISO 8601 token expiry, or `null`.                             |
| `isExpiringSoon`             | `true` if the token is within the refresh threshold.          |
| `getToken()`                 | Returns the current token, refreshing first if needed.        |
| `verify(caps?)`              | Verify this agent's token and optionally assert capabilities. |
| `checkPermission(cap, ctx?)` | Check whether this agent may perform an action.               |
| `getReputation()`            | Fetch this agent's current trust score and stats.             |
| `revoke()`                   | Immediately revoke this agent's token.                        |
| `toJSON()`                   | Serialise to a plain object for storage.                      |

---

### `agentid.verify(token, requiredCapabilities?)` → `Promise<VerifyResponse>`

Verify a raw token string. Public endpoint — no API key required on the request.

```js
const result = await vouchid.verify(token, ["read:filesystem"]);

result.valid; // true
result.agent_id; // "agent_01jk2m3n4p5q6r7s"
result.agent_name; // "my-bot"
result.capabilities; // ["read:filesystem"]
result.trust_level; // "verified"
result.trust_score; // 91
```

---

### `agentid.checkPermission(agentId, capability, context?)` → `Promise<PermissionResponse>`

Check whether an agent is allowed to perform an action.

```js
const result = await vouchid.checkPermission(
  "agent_01jk2m3n4p5q6r7s",
  "write:reports",
  { resource: "quarterly-summary" }, // optional context
);

result.allowed; // true or false
result.reason; // explanation if denied
```

---

### `agentid.getReputation(agentId)` → `Promise<ReputationResponse>`

```js
const rep = await vouchid.getReputation("agent_01jk2m3n4p5q6r7s");

rep.trustScore; // 91
rep.totalVerifications; // 847
rep.successRate; // 0.99
```

---

### `agentid.listAgents()` → `Promise<object[]>`

List all agents registered to your organisation.

---

### `agentid.revoke(agentId)` → `Promise<object>`

Immediately revoke an agent's token.

---

## Error handling

All SDK methods throw `AgentIDError` on failure.

```js
import { AgentIDError } from "@vouchid/sdk";

try {
  const agent = await vouchid.register({
    name: "my-bot",
    capabilities: ["read:data"],
  });
} catch (err) {
  if (err instanceof AgentIDError) {
    console.error(`[${err.code}] ${err.message}`);
    // err.statusCode — HTTP status if applicable
    // err.path       — API path that was called
  }
}
```

| Code             | Cause                                             |
| ---------------- | ------------------------------------------------- |
| `INVALID_CONFIG` | Missing or invalid constructor options.           |
| `INVALID_INPUT`  | Invalid argument passed to a method.              |
| `API_ERROR`      | Backend returned a non-2xx response.              |
| `NETWORK_ERROR`  | Request failed due to a network issue or timeout. |
| `PARSE_ERROR`    | Backend response could not be parsed.             |

---

## Full example

```js
import { AgentID, AgentIDError } from "@vouchid/sdk";

const vouchid = new AgentID({
  apiUrl: process.env.VOUCHID_API_URL,
  apiKey: process.env.VOUCHID_API_KEY,
});

// Register once, then persist
let agentState = await loadFromDB("my-bot"); // returns null on first run

let agent;
if (agentState) {
  agent = vouchid.loadAgent(agentState);
} else {
  agent = await vouchid.register({
    name: "my-bot",
    capabilities: ["read:filesystem"],
  });
  await saveToDB("my-bot", agent.toJSON());
}

// On every MCP call
const token = await agent.getToken();

await mcpClient.callTool({
  name: "read_file",
  arguments: {
    path: "/data/report.csv",
    _agentid_token: token,
  },
});
```

---

## License

MIT
