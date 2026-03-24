/**
 * @agentid/sdk — Official AgentID SDK
 *
 * Register agents, manage tokens with automatic refresh, verify identities,
 * and check permissions — all with built-in timeout & retry handling.
 *
 * @example
 *   import { AgentID } from "@agentid/sdk";
 *
 *   const agentid = new AgentID({
 *     apiUrl: process.env.AGENTID_API_URL,
 *     apiKey: process.env.AGENTID_API_KEY,
 *   });
 *
 *   const agent = await agentid.register({
 *     name:         "data-pipeline-bot",
 *     capabilities: ["read:data", "write:reports"],
 *     model:        "gpt-4o",
 *   });
 *
 *   const token = await agent.getToken(); // auto-refreshes near expiry
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Refresh token if fewer than this many days remain. */
const DEFAULT_REFRESH_THRESHOLD_DAYS = 7;

/** Per-request timeout in ms. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Retry attempts on transient network / server errors. */
const DEFAULT_MAX_RETRIES = 3;

/** Base back-off delay in ms. Doubles on each retry. */
const RETRY_BASE_DELAY_MS = 250;

/** HTTP status codes considered safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Regex for capability strings of the form "scope:action". */
const CAPABILITY_PATTERN = /^[\w-]+:[\w:*-]+$/;

// ─── AgentID ──────────────────────────────────────────────────────────────────

export class AgentID {
  /**
   * @param {object}   options
   * @param {string}   options.apiKey                  - Your org API key.
   * @param {string}   [options.apiUrl]                - Your VouchID API URL.
   * @param {number}   [options.refreshThresholdDays]  - Days before expiry to auto-refresh (default 7).
   * @param {number}   [options.timeoutMs]             - Request timeout in ms (default 10 000).
   * @param {number}   [options.maxRetries]            - Retry count for transient errors (default 3).
   * @param {object}   [options.logger]                - Custom logger with `.info()`, `.warn()`, `.error()`.
   *                                                     Pass `null` to silence all output.
   */
  constructor(options = {}) {
    if (!options.apiKey)
      throw new AgentIDError("INVALID_CONFIG", "apiKey is required.");
    if (!options.apiUrl)
      throw new AgentIDError("INVALID_CONFIG", "apiUrl is required.");

    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.refreshThresholdDays =
      options.refreshThresholdDays ?? DEFAULT_REFRESH_THRESHOLD_DAYS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.logger =
      options.logger === null
        ? _noopLogger
        : (options.logger ?? _defaultLogger);
  }

  // ── Agent management ───────────────────────────────────────────────────────

  /**
   * Register a new agent and return an `AgentClient` that manages its token.
   *
   * @param {object}   params
   * @param {string}   params.name          - Descriptive name for the agent.
   * @param {string[]} params.capabilities  - Capability strings e.g. `["read:data", "write:reports"]`.
   * @param {string}   [params.model]       - Underlying model identifier e.g. `"gpt-4o"`.
   * @returns {Promise<AgentClient>}
   */
  async register({ name, capabilities, model } = {}) {
    _validateAgentName(name);
    _validateCapabilities(capabilities);

    const data = await this._request("POST", "/v1/agents/register", {
      name,
      capabilities,
      ...(model ? { model } : {}),
    });

    this.logger.info(`[AgentID] Registered agent "${name}" (${data.agent_id})`);

    return new AgentClient({
      sdk: this,
      agentId: data.agent_id,
      token: data.token,
      expiresAt: data.expires_at,
      capabilities: data.capabilities,
      trustLevel: data.trust_level,
    });
  }

  /**
   * Restore a previously registered agent from serialised state.
   * Use `agent.toJSON()` to obtain state for storage.
   *
   * @param {object} params
   * @param {string} params.agentId
   * @param {string} params.token
   * @param {string} [params.expiresAt]
   * @param {string[]} [params.capabilities]
   * @param {string} [params.trustLevel]
   * @returns {AgentClient}
   */
  loadAgent({ agentId, token, expiresAt, capabilities, trustLevel } = {}) {
    if (!agentId)
      throw new AgentIDError("INVALID_CONFIG", "agentId is required.");
    if (!token) throw new AgentIDError("INVALID_CONFIG", "token is required.");

    return new AgentClient({
      sdk: this,
      agentId,
      token,
      expiresAt,
      capabilities,
      trustLevel,
    });
  }

  // ── Token & verification ───────────────────────────────────────────────────

  /**
   * Verify a raw token string.
   * This is a public endpoint — no API key needed.
   *
   * @param {string}   token
   * @param {string[]} [requiredCapabilities=[]]  - Optional capability assertions.
   * @returns {Promise<VerifyResponse>}
   */
  async verify(token, requiredCapabilities = []) {
    if (!token || typeof token !== "string") {
      throw new AgentIDError(
        "INVALID_INPUT",
        "token must be a non-empty string.",
      );
    }

    return this._request(
      "POST",
      "/v1/agents/verify",
      { token, required_capabilities: requiredCapabilities },
      { auth: false },
    );
  }

  // ── Permission & reputation ────────────────────────────────────────────────

  /**
   * Check whether an agent is allowed to perform an action.
   *
   * @param {string} agentId
   * @param {string} capability
   * @param {object} [context={}]
   * @returns {Promise<PermissionResponse>}
   */
  async checkPermission(agentId, capability, context = {}) {
    if (!agentId)
      throw new AgentIDError("INVALID_INPUT", "agentId is required.");
    if (!capability)
      throw new AgentIDError("INVALID_INPUT", "capability is required.");

    return this._request("POST", "/v1/agents/check-permission", {
      agent_id: agentId,
      capability,
      context,
    });
  }

  /**
   * Fetch the current reputation score for an agent.
   *
   * @param {string} agentId
   * @returns {Promise<ReputationResponse>}
   */
  async getReputation(agentId) {
    if (!agentId)
      throw new AgentIDError("INVALID_INPUT", "agentId is required.");
    return this._request(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/reputation`,
    );
  }

  /**
   * List all agents registered to your organisation.
   *
   * @returns {Promise<object[]>}
   */
  async listAgents() {
    return this._request("GET", "/v1/agents");
  }

  /**
   * Immediately revoke an agent token.
   *
   * @param {string} agentId
   * @returns {Promise<object>}
   */
  async revoke(agentId) {
    if (!agentId)
      throw new AgentIDError("INVALID_INPUT", "agentId is required.");
    return this._request(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentId)}/revoke`,
    );
  }

  // ── Internal HTTP helper ───────────────────────────────────────────────────

  /**
   * Execute an HTTP request with timeout and exponential back-off retry.
   *
   * @param {string}  method
   * @param {string}  path
   * @param {object}  [body]
   * @param {object}  [opts]
   * @param {boolean} [opts.auth=true] - Whether to include the Authorization header.
   * @returns {Promise<object>}
   */
  async _request(method, path, body = null, { auth = true } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await _sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        this.logger.warn(
          `[AgentID] Retrying ${method} ${path} (attempt ${attempt + 1})`,
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers = { "Content-Type": "application/json" };
        if (auth) headers["Authorization"] = `Bearer ${this.apiKey}`;

        const res = await fetch(`${this.apiUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Retry on rate-limit or transient server errors
        if (RETRYABLE_STATUS_CODES.has(res.status)) {
          lastError = new AgentIDError(
            "API_ERROR",
            `Received ${res.status} from AgentID API.`,
          );
          continue;
        }

        // Parse response body once, even on error
        let data;
        try {
          data = await res.json();
        } catch {
          throw new AgentIDError(
            "PARSE_ERROR",
            `Failed to parse AgentID API response (${res.status}).`,
          );
        }

        if (!res.ok) {
          throw new AgentIDError(
            "API_ERROR",
            data?.error ?? `Request failed with status ${res.status}.`,
            res.status,
            path,
          );
        }

        return data;
      } catch (err) {
        clearTimeout(timer);

        // Hard failures (our own errors, auth errors) should not be retried
        if (err instanceof AgentIDError) {
          if (err.statusCode && err.statusCode < 500 && err.statusCode !== 429)
            throw err;
          lastError = err;
          continue;
        }

        const isTimeout = err.name === "AbortError";
        lastError = new AgentIDError(
          "NETWORK_ERROR",
          isTimeout
            ? `Request to AgentID API timed out after ${this.timeoutMs}ms.`
            : `Network error: ${err.message}`,
        );
      }
    }

    throw lastError;
  }
}

// ─── AgentClient ─────────────────────────────────────────────────────────────

/**
 * Represents a single registered agent.
 * Returned by `AgentID.register()` and `AgentID.loadAgent()`.
 */
export class AgentClient {
  /**
   * @param {object}   params
   * @param {AgentID}  params.sdk
   * @param {string}   params.agentId
   * @param {string}   params.token
   * @param {string}   [params.expiresAt]
   * @param {string[]} [params.capabilities]
   * @param {string}   [params.trustLevel]
   */
  constructor({ sdk, agentId, token, expiresAt, capabilities, trustLevel }) {
    this._sdk = sdk;
    this.agentId = agentId;
    this.capabilities = capabilities ?? [];
    this.trustLevel = trustLevel ?? "untrusted";

    this._token = token;
    this._expiresAt = expiresAt ? new Date(expiresAt) : null;
    this._refreshLock = null; // prevents concurrent refresh calls
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  /** ISO 8601 expiry string, or null if unknown. */
  get expiresAt() {
    return this._expiresAt?.toISOString() ?? null;
  }

  /** True if the token is expired or will expire before the refresh threshold. */
  get isExpiringSoon() {
    return this._needsRefresh();
  }

  // ── Core methods ───────────────────────────────────────────────────────────

  /**
   * Return the current token, automatically refreshing it if it is within
   * the refresh threshold (default: 7 days before expiry).
   *
   * @returns {Promise<string>}
   */
  async getToken() {
    if (this._needsRefresh()) await this._refresh();
    return this._token;
  }

  /**
   * Verify this agent's token, refreshing if needed.
   * Returns the full verification result including live trust score.
   *
   * @param {string[]} [requiredCapabilities=[]]
   * @returns {Promise<VerifyResponse>}
   */
  async verify(requiredCapabilities = []) {
    const token = await this.getToken();
    return this._sdk.verify(token, requiredCapabilities);
  }

  /**
   * Check whether this agent is allowed to perform an action.
   *
   * @param {string} capability
   * @param {object} [context={}]
   * @returns {Promise<PermissionResponse>}
   */
  async checkPermission(capability, context = {}) {
    return this._sdk.checkPermission(this.agentId, capability, context);
  }

  /**
   * Retrieve this agent's current reputation score.
   *
   * @returns {Promise<ReputationResponse>}
   */
  async getReputation() {
    return this._sdk.getReputation(this.agentId);
  }

  /**
   * Immediately revoke this agent.
   *
   * @returns {Promise<object>}
   */
  async revoke() {
    return this._sdk.revoke(this.agentId);
  }

  /**
   * Serialise to a plain object suitable for storage (DB, env var, file, etc.).
   * Restore with `AgentID.loadAgent(agent.toJSON())`.
   *
   * @returns {SerializedAgent}
   */
  toJSON() {
    return {
      agentId: this.agentId,
      token: this._token,
      expiresAt: this.expiresAt,
      capabilities: this.capabilities,
      trustLevel: this.trustLevel,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _needsRefresh() {
    if (!this._expiresAt) return false;

    const thresholdMs = this._sdk.refreshThresholdDays * 24 * 60 * 60 * 1000;
    const timeUntilExp = this._expiresAt.getTime() - Date.now();
    return timeUntilExp < thresholdMs;
  }

  async _refresh() {
    // Coalesce concurrent refresh calls — only one in-flight at a time.
    if (this._refreshLock) return this._refreshLock;

    this._refreshLock = this._doRefresh().finally(() => {
      this._refreshLock = null;
    });

    return this._refreshLock;
  }

  async _doRefresh() {
    try {
      const data = await this._sdk._request(
        "POST",
        `/v1/agents/${encodeURIComponent(this.agentId)}/refresh`,
      );

      this._token = data.token;
      this._expiresAt = new Date(data.expires_at);
      this.capabilities = data.capabilities ?? this.capabilities;

      this._sdk.logger.info(
        `[AgentID] Token refreshed for agent ${this.agentId} — expires ${data.expires_at}`,
      );
    } catch (err) {
      // Log but do not throw — let the caller use the existing (possibly stale) token.
      // A hard auth failure at the verify step will surface the problem to the caller.
      this._sdk.logger.error(
        `[AgentID] Token refresh failed for agent ${this.agentId}: ${err.message}`,
      );
    }
  }
}

// ─── AgentIDError ─────────────────────────────────────────────────────────────

/**
 * Thrown by all AgentID SDK operations on failure.
 * Catch this to handle AgentID errors without swallowing unrelated exceptions.
 *
 * @property {string}      code       - Machine-readable error code.
 * @property {number|null} statusCode - HTTP status code, if applicable.
 * @property {string|null} path       - API path that was called, if applicable.
 */
export class AgentIDError extends Error {
  constructor(code, message, statusCode = null, path = null) {
    super(message);
    this.name = "AgentIDError";
    this.code = code;
    this.statusCode = statusCode;
    this.path = path;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AgentIDError);
    }
  }
}

// ─── Private utilities ────────────────────────────────────────────────────────

function _validateAgentName(name) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AgentIDError("INVALID_INPUT", "name must be a non-empty string.");
  }
  if (name.length > 128) {
    throw new AgentIDError(
      "INVALID_INPUT",
      "name must be 128 characters or fewer.",
    );
  }
}

function _validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new AgentIDError(
      "INVALID_INPUT",
      "capabilities must be a non-empty array.",
    );
  }

  for (const cap of capabilities) {
    if (typeof cap !== "string" || !CAPABILITY_PATTERN.test(cap)) {
      throw new AgentIDError(
        "INVALID_INPUT",
        `Invalid capability "${cap}". Expected format: "scope:action" e.g. "read:data".`,
      );
    }
  }
}

/** @param {number} ms */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const _noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const _defaultLogger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} SerializedAgent
 * @property {string}   agentId
 * @property {string}   token
 * @property {string|null} expiresAt
 * @property {string[]} capabilities
 * @property {string}   trustLevel
 */

/**
 * @typedef {object} VerifyResponse
 * @property {boolean}  valid
 * @property {string}   [reason]
 * @property {string}   agent_id
 * @property {string}   agent_name
 * @property {string[]} capabilities
 * @property {string}   trust_level
 * @property {number}   trust_score
 */

/**
 * @typedef {object} PermissionResponse
 * @property {boolean} allowed
 * @property {string}  [reason]
 */

/**
 * @typedef {object} ReputationResponse
 * @property {number} trustScore
 * @property {number} totalVerifications
 * @property {number} successRate
 */
