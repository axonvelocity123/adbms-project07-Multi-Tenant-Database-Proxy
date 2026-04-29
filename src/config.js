'use strict';

const fs = require('fs');
const path = require('path');

function loadTenants(configPath) {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Tenant config file not found: ${resolved}`);
  }

  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  const tenants = new Map();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();

    if (!raw || raw.startsWith('#')) continue;

    const parts = raw.split(':');
    if (parts.length !== 4) {
      throw new Error(
        `tenants.conf line ${i + 1}: expected 4 colon-separated fields, got ${parts.length}: "${raw}"`
      );
    }

    const [tenant_id, api_key, rateStr, maxConnStr] = parts.map(p => p.trim());

    if (!/^[a-z0-9_]+$/.test(tenant_id)) {
      throw new Error(
        `tenants.conf line ${i + 1}: tenant_id "${tenant_id}" must be lowercase alphanumeric`
      );
    }

    const rate_limit = parseInt(rateStr, 10);
    const max_connections = parseInt(maxConnStr, 10);

    if (isNaN(rate_limit) || rate_limit <= 0) {
      throw new Error(
        `tenants.conf line ${i + 1}: invalid rate_limit_per_sec "${rateStr}"`
      );
    }
    if (isNaN(max_connections) || max_connections <= 0) {
      throw new Error(
        `tenants.conf line ${i + 1}: invalid max_connections "${maxConnStr}"`
      );
    }
    if (tenants.has(tenant_id)) {
      throw new Error(
        `tenants.conf line ${i + 1}: duplicate tenant_id "${tenant_id}"`
      );
    }

    tenants.set(tenant_id, {
      tenant_id,
      api_key,
      rate_limit,
      max_connections,
      schema: `tenant_${tenant_id}`,
    });
  }

  if (tenants.size === 0) {
    throw new Error('tenants.conf contains no valid tenant entries');
  }

  return tenants;
}

module.exports = { loadTenants };
