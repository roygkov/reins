'use strict';
// The gate part of agentic v0.5.8 (a4ba285), plugin/lib/config.js: the layers of the rule data.
// Layers: built-in data/gate.json -> personal (~/.config/reins/config.json) -> this repository's personal
// entry -> the repository (.reins/config.json). Layers only add rules.
// Not ported: allow_forms (the task envelope replaces it) and the keys of the agentic workflow.
const path = require('path');
const { CONFIG_DIR, readJson, data } = require('./util.cjs');

const LIST_KEYS = ['markers', 'protected_branches', 'prod_hosts', 'prod_scripts', 'prod_fastlane_lanes', 'mcp_prod_servers', 'forms', 'ignore'];

function userConfig() { return readJson(path.join(CONFIG_DIR, 'config.json'), {}); }
function projectConfig(root) { return root ? readJson(path.join(root, '.reins', 'config.json'), {}) : {}; }

function load(info) {
  const base = data('gate.json');
  const user = userConfig();
  const project = projectConfig(info && info.root);
  const repoUser = (user.repos && info && user.repos[info.key]) || {};
  const out = { markers: [], protected_branches: [], prod_hosts: [], prod_scripts: [], prod_fastlane_lanes: [], mcp_prod_servers: [], forms: [], ignore: [] };
  for (const layer of [base, user, repoUser, project]) {
    for (const k of LIST_KEYS) {
      if (Array.isArray(layer[k])) for (const v of layer[k]) if (!out[k].includes(v)) out[k].push(v);
    }
  }
  out.rules = (base.rules || []).concat(user.rules || [], repoUser.rules || [], project.rules || []);
  out.exempt_flags = base.exempt_flags || [];
  return out;
}

module.exports = { load, userConfig, projectConfig, LIST_KEYS };
