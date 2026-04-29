'use strict';

const TENANT_SCHEMA_REF = /tenant_[a-z0-9_]+\s*\.\s*\w+/i;

const SET_SEARCH_PATH = /\bset\s+search_path\b/i;

const SET_ROLE = /\bset\s+role\b/i;

const SET_SESSION_AUTH = /\bset\s+session\s+authorization\b/i;

function checkQuery(sql) {
  if (TENANT_SCHEMA_REF.test(sql)) {
    return {
      ok: false,
      reason: 'explicit cross-tenant schema reference is not allowed',
    };
  }
  if (SET_SEARCH_PATH.test(sql)) {
    return {
      ok: false,
      reason: 'SET search_path is not allowed from tenant sessions',
    };
  }
  if (SET_ROLE.test(sql)) {
    return {
      ok: false,
      reason: 'SET ROLE is not allowed from tenant sessions',
    };
  }
  if (SET_SESSION_AUTH.test(sql)) {
    return {
      ok: false,
      reason: 'SET SESSION AUTHORIZATION is not allowed from tenant sessions',
    };
  }
  return { ok: true };
}

module.exports = { checkQuery };
