// Per-session compiler-object reuse. Preserve source paths, all headers and
// time macros; never apply the relaxed PCH cache settings used by other lanes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function resolveAccelerationOptions(input, profile = {}, environment = process.env) {
  const requested = {};
  for (const name of ['objectCache', 'pipeCompilation']) {
    const value = input[name] === undefined ? (profile[name] === undefined ? false : profile[name]) : input[name];
    if (typeof value !== 'boolean') throw new Error(name + ' must be a JSON boolean');
    requested[name] = value;
  }
  // The package fingerprint covers the installed compiler, not a replacement
  // cc1/assembler selected outside it by a caller's compiler environment.
  const qualified = !['COMPILER_PATH', 'GCC_EXEC_PREFIX', 'GCC_COMPARE_DEBUG'].some(name => environment[name]);
  return { objectCache: qualified && requested.objectCache, pipeCompilation: qualified && requested.pipeCompilation,
    requestedAcceleration: requested, accelerationDisabledReason: !qualified && (requested.objectCache || requested.pipeCompilation)
      ? 'compiler-environment-override' : null };
}

export function compilerInvocationCacheable(expandedArguments) {
  return !expandedArguments.some(arg => /^(?:-B|-specs(?:=|$)|--specs(?:=|$)|-fplugin(?:=|$)|-wrapper(?:=|$))/.test(arg));
}

export function nativeDependencyTarget(output) {
  if (/[\r\n\0]/.test(output)) throw new Error('Unsupported dependency target');
  // Match GCC's native Windows -MMD target. An explicit -MT keeps ccache hits
  // from rewriting it to C\:\\... GNU spelling that Arduino CLI cannot read.
  return output.replace(/[$]/g, '$$$$').replace(/[ #\t]/g, '\\$&');
}

export function toolchainFingerprint(root) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  function visit(file) {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error('Linked compiler input cannot qualify an object cache');
    const relative = path.relative(root, file).replaceAll('\\', '/');
    hash.update(JSON.stringify([relative, info.isDirectory() ? 'directory' : info.size]) + '\n');
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else {
      if (!info.isFile()) throw new Error('Unsupported compiler input');
      const fd = fs.openSync(file, 'r');
      try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
    }
  }
  visit(root); return hash.digest('hex');
}

export function objectCacheConfig(directory, namespace) {
  if (/[\r\n]/.test(directory) || !/^[a-f0-9]{64}$/.test(namespace)) throw new Error('Invalid object cache configuration');
  return ['cache_dir = ' + directory.replaceAll('\\', '/'), 'namespace = ' + namespace,
    'max_size = 1G', 'compiler_check = content', 'hash_dir = true', 'direct_mode = false',
    'depend_mode = false', 'hard_link = false', 'file_clone = false', 'inode_cache = false',
    'sloppiness =', 'base_dir =', 'compression = true', 'compression_level = 1'].join('\n') + '\n';
}

export function objectCacheEnvironment(environment, configFile, statsFile) {
  const result = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^CCACHE_/i.test(name)));
  result.CCACHE_CONFIGPATH = configFile;
  result.CCACHE_STATSLOG = statsFile;
  if (environment.CK_NATIVE_GRAPH_RECACHE === '1') result.CCACHE_RECACHE = 'true';
  return result;
}

export function objectCacheMode(log) {
  const stats = new Set(log.split(/\r?\n/).map(line => line.trim()));
  if (stats.has('direct_cache_hit')) return 'ccache-direct-hit';
  if (stats.has('preprocessed_cache_hit')) return 'ccache-preprocessed-hit';
  if (stats.has('cache_miss')) return 'ccache-miss';
  return 'ccache-uncached';
}
