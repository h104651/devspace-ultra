const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--release-dir' && next) { parsed.releaseDir = next; i++; }
    else if (a === '--config-dir' && next) { parsed.configDir = next; i++; }
    else if (a === '--log-dir' && next) { parsed.logDir = next; i++; }
    else if (a === '--env-file' && next) { parsed.envFile = next; i++; }
    else if (a === '--service-config' && next) { parsed.serviceConfig = next; i++; }
    else if (a === '--shutdown-timeout-ms' && next) { parsed.shutdownTimeoutMs = Number(next); i++; }
  }
  return parsed;
}

function loadDotEnvFile(envPath, releaseDir) {
  if (!fs.existsSync(envPath)) return {};
  // An independently installed launcher has no node_modules of its own.
  // Prefer the configured release's parser; an in-repository launcher can also
  // resolve its existing dependency (including isolated test release fixtures).
  const dotenv = require(require.resolve('dotenv', { paths: [releaseDir, __dirname] }));
  return dotenv.parse(fs.readFileSync(envPath));
}

function resolveConfiguration(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  const defaultReleaseDir = path.resolve(__dirname, '..', '..');

  const serviceConfigPath = path.resolve(
    cli.serviceConfig || process.env.DEVSPACE_SERVICE_CONFIG || path.join(__dirname, 'service-config.json')
  );
  let serviceCfg = {};
  if (fs.existsSync(serviceConfigPath)) {
    serviceCfg = JSON.parse(fs.readFileSync(serviceConfigPath, 'utf8'));
  } else if (cli.serviceConfig || process.env.DEVSPACE_SERVICE_CONFIG) {
    throw new Error('Explicit service configuration file not found');
  }

  // Paths in service-config.json are relative to that file, never the launcher's working directory.
  const configBase = path.dirname(serviceConfigPath);
  const resolveSetting = (override, configured, fallback, base = configBase) =>
    override ? path.resolve(override) : configured ? path.resolve(base, configured) : path.resolve(fallback);
  const releaseDir = resolveSetting(cli.releaseDir || process.env.DEVSPACE_RELEASE_DIR, serviceCfg.releaseDir, defaultReleaseDir);
  const configDir = resolveSetting(cli.configDir || process.env.DEVSPACE_CONFIG_DIR, serviceCfg.configDir, releaseDir);
  const logDir = resolveSetting(cli.logDir || process.env.DEVSPACE_LOG_DIR, serviceCfg.logDir, path.join(configDir, 'logs'));
  const envPath = resolveSetting(cli.envFile || process.env.DEVSPACE_ENV_FILE, serviceCfg.envFile, path.join(configDir, '.env'), configDir);

  const maxLogBytes = Math.max(1024, Number(process.env.DEVSPACE_LOG_MAX_BYTES || serviceCfg.maxLogBytes) || 10 * 1024 * 1024);
  const maxLogFiles = Math.max(1, Number(process.env.DEVSPACE_LOG_MAX_FILES || serviceCfg.maxLogFiles) || 5);
  const maxRapidRestarts = Math.max(1, Number(process.env.DEVSPACE_MAX_RAPID_RESTARTS || serviceCfg.maxRapidRestarts) || 5);
  const shutdownTimeoutMs = Math.min(30000, Math.max(500, Number(cli.shutdownTimeoutMs || process.env.DEVSPACE_SHUTDOWN_TIMEOUT_MS || serviceCfg.shutdownTimeoutMs) || 10000));

  return {
    serviceConfigPath,
    releaseDir,
    configDir,
    logDir,
    envPath,
    maxLogBytes,
    maxLogFiles,
    maxRapidRestarts,
    shutdownTimeoutMs
  };
}

function resolveIdentity(cfg) {
  const fileEnv = loadDotEnvFile(cfg.envPath, cfg.releaseDir);
  const normalized = {};
  for (const [k,v] of Object.entries(process.env)) normalized[k.toUpperCase()] = v;
  for (const [k,v] of Object.entries(fileEnv)) normalized[k.toUpperCase()] = v;
  return String(normalized.AGENT_ID || '').trim();
}

module.exports = { resolveConfiguration, loadDotEnvFile, resolveIdentity };

if (require.main === module) {
  try {
    const cfg = resolveConfiguration();
    const deviceId = resolveIdentity(cfg);
    if (!deviceId) throw new Error('Missing AGENT_ID in resolved service configuration');
    // This command deliberately never returns the environment or the device credential.
    console.log(JSON.stringify({ deviceId, releaseDir: cfg.releaseDir, configDir: cfg.configDir, envPath: cfg.envPath, logDir: cfg.logDir, serviceConfigPath: cfg.serviceConfigPath }));
  } catch (err) {
    console.error('Unable to resolve service configuration');
    process.exitCode = 1;
  }
}
