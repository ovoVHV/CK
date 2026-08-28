#!/usr/bin/env node
'use strict';

// Deterministic, name-agnostic Arduino library fixtures for exercising CK's
// AVR dependency-graph transition path.  The names intentionally carry no
// relationship to a real library or vendor: production compatibility must be
// derived from Arduino topology and metadata, never from a library allow-list.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_SCHEMA_ID = 'ck.avr.generic-library-topology-fixture';
const FIXTURE_SCHEMA_VERSION = 2;
const OWNERSHIP_MARKER = '.ck-avr-topology-fixture.json';
const LIBRARY_NAMES = Object.freeze([
  'CKTopoA17',
  'CKTopoB29',
  'CKTopoC43',
  'CKTopoD61',
]);

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestObject(value) {
  return sha256Bytes(canonicalJson(value));
}

function libraryProperties(name, { depends = [] } = {}) {
  return [
    `name=${name}`,
    'version=1.0.0',
    'author=CK deterministic regression fixture',
    'maintainer=CK deterministic regression fixture',
    'sentence=Name-agnostic AVR topology regression fixture.',
    'paragraph=Generated only for compile-only CK versus Arduino CLI equivalence checks.',
    'category=Other',
    'url=https://invalid.example/ck-avr-topology-fixture',
    'architectures=avr',
    ...(depends.length > 0 ? [`depends=${depends.join(', ')}`] : []),
    '',
  ].join('\n');
}

const LIBRARIES = Object.freeze([
  Object.freeze({
    name: 'CKTopoA17',
    shape: 'modern-src-single-tu',
    depends: Object.freeze(['CKTopoB29']),
    translationUnits: Object.freeze(['src/CKTopoA17.cpp']),
    files: Object.freeze({
      'library.properties': libraryProperties('CKTopoA17', { depends: ['CKTopoB29'] }),
      'src/CKTopoA17.h': [
        '#ifndef CK_TOPO_A17_H',
        '#define CK_TOPO_A17_H',
        '#include <stdint.h>',
        'uint16_t ck_topo_a17(uint16_t value);',
        '#endif',
        '',
      ].join('\n'),
      'src/CKTopoA17.cpp': [
        '#include "CKTopoA17.h"',
        '#include <CKTopoB29.h>',
        'uint16_t ck_topo_a17(uint16_t value) {',
        '  return (uint16_t)(ck_topo_b29(value) + 17U);',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  Object.freeze({
    name: 'CKTopoB29',
    shape: 'modern-src-deep-mixed-c-cpp',
    depends: Object.freeze(['CKTopoC43']),
    translationUnits: Object.freeze(['src/CKTopoB29.cpp', 'src/nested/CKTopoB29Detail.c']),
    files: Object.freeze({
      'library.properties': libraryProperties('CKTopoB29', { depends: ['CKTopoC43'] }),
      'src/CKTopoB29.h': [
        '#ifndef CK_TOPO_B29_H',
        '#define CK_TOPO_B29_H',
        '#include <stdint.h>',
        'uint16_t ck_topo_b29(uint16_t value);',
        '#endif',
        '',
      ].join('\n'),
      'src/CKTopoB29.cpp': [
        '#include "CKTopoB29.h"',
        '#include "nested/CKTopoB29Detail.h"',
        '#include <CKTopoC43.h>',
        'uint16_t ck_topo_b29(uint16_t value) {',
        '  return ck_topo_c43(ck_topo_b29_detail(value));',
        '}',
        '',
      ].join('\n'),
      'src/nested/CKTopoB29Detail.h': [
        '#ifndef CK_TOPO_B29_DETAIL_H',
        '#define CK_TOPO_B29_DETAIL_H',
        '#include <stdint.h>',
        '#ifdef __cplusplus',
        'extern "C" {',
        '#endif',
        'uint16_t ck_topo_b29_detail(uint16_t value);',
        '#ifdef __cplusplus',
        '}',
        '#endif',
        '#endif',
        '',
      ].join('\n'),
      'src/nested/CKTopoB29Detail.c': [
        '#include "CKTopoB29Detail.h"',
        'uint16_t ck_topo_b29_detail(uint16_t value) {',
        '  return (uint16_t)(value * 3U + 29U);',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  Object.freeze({
    name: 'CKTopoC43',
    shape: 'modern-src-header-only',
    depends: Object.freeze([]),
    translationUnits: Object.freeze([]),
    files: Object.freeze({
      'library.properties': libraryProperties('CKTopoC43'),
      'src/CKTopoC43.h': [
        '#ifndef CK_TOPO_C43_H',
        '#define CK_TOPO_C43_H',
        '#include <stdint.h>',
        'static inline uint16_t ck_topo_c43(uint16_t value) {',
        '  return (uint16_t)(value ^ 43U);',
        '}',
        '#endif',
        '',
      ].join('\n'),
    }),
  }),
  Object.freeze({
    name: 'CKTopoD61',
    shape: 'modern-src-single-tu-second-direct-root',
    depends: Object.freeze([]),
    translationUnits: Object.freeze(['src/CKTopoD61.cpp']),
    files: Object.freeze({
      'library.properties': libraryProperties('CKTopoD61'),
      'src/CKTopoD61.h': [
        '#ifndef CK_TOPO_D61_H',
        '#define CK_TOPO_D61_H',
        '#include <stdint.h>',
        'uint16_t ck_topo_d61(uint16_t value);',
        '#endif',
        '',
      ].join('\n'),
      'src/CKTopoD61.cpp': [
        '#include "CKTopoD61.h"',
        'uint16_t ck_topo_d61(uint16_t value) {',
        '  return (uint16_t)(value + 61U);',
        '}',
        '',
      ].join('\n'),
    }),
  }),
]);

function sketch({ includeOrder = [], seed = 1, useD61 = false } = {}) {
  const includes = includeOrder.map((name) => `#include <${name}.h>`);
  const expression = useD61
    ? `ck_topo_a17(${seed}U) + ck_topo_d61(${seed + 1}U)`
    : `ck_topo_a17(${seed}U)`;
  return [
    ...includes,
    '',
    'volatile uint16_t ck_topology_sink = 0;',
    'void setup() {',
    `  ck_topology_sink = (uint16_t)(${expression});`,
    '}',
    'void loop() {',
    '  if (ck_topology_sink == 0xFFFFU) {',
    `    ck_topology_sink = (uint16_t)(${expression});`,
    '  }',
    '}',
    '',
  ].join('\n');
}

const CORE_BASELINE_CODE = [
  '#include <Arduino.h>',
  'volatile uint8_t ck_topology_sink = 0;',
  'void setup() { ck_topology_sink = 17U; }',
  'void loop() { if (ck_topology_sink == 0U) ck_topology_sink = 17U; }',
  '',
].join('\n');

function expectedOrderedTUs(expectedOrderedLibraries) {
  return expectedOrderedLibraries.flatMap((libraryName) => {
    const library = LIBRARIES.find((candidate) => candidate.name === libraryName);
    if (!library) throw new Error(`unknown ordered fixture library: ${libraryName}`);
    return library.translationUnits.map((sourceRelativePath) => Object.freeze({
      library: library.name,
      sourceRelativePath,
      language: path.extname(sourceRelativePath).toLowerCase() === '.c' ? 'c' : 'cpp',
    }));
  });
}

function stage(
  id,
  transitionKind,
  expectedRoute,
  code,
  directLibraries,
  expectedLibrarySet,
  expectedOrderedLibraries,
) {
  const orderedTUs = expectedOrderedTUs(expectedOrderedLibraries);
  return Object.freeze({
    id,
    transitionKind,
    expectedRoute,
    directLibraries: Object.freeze([...directLibraries]),
    // `expectedLibrarySet` is membership evidence only. The separate ordered
    // fields follow Arduino CLI's FIFO recursive-include discovery order.
    // Neither field claims to be the final linker command order.
    expectedLibrarySet: Object.freeze([...expectedLibrarySet]),
    expectedOrderedLibraries: Object.freeze([...expectedOrderedLibraries]),
    expectedCcdbObservableLibraryOrder: Object.freeze([
      ...new Set(orderedTUs.map((unit) => unit.library)),
    ]),
    expectedOrderedTUs: Object.freeze(orderedTUs),
    expectedHeaders: Object.freeze(directLibraries.map((name) => `${name}.h`)),
    code,
    sourceSha256: sha256Bytes(code),
  });
}

const FULL_LIBRARY_SET = Object.freeze(['CKTopoA17', 'CKTopoB29', 'CKTopoC43', 'CKTopoD61']);
const PARTIAL_LIBRARY_SET = Object.freeze(['CKTopoA17', 'CKTopoB29', 'CKTopoC43']);
const ADD_ORDER = Object.freeze(['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43']);
const REORDERED_ORDER = Object.freeze(['CKTopoD61', 'CKTopoA17', 'CKTopoB29', 'CKTopoC43']);
const PARTIAL_ORDER = Object.freeze(['CKTopoA17', 'CKTopoB29', 'CKTopoC43']);
const ADD_CODE = sketch({ includeOrder: ['CKTopoA17', 'CKTopoD61'], seed: 3, useD61: true });
const TOPOLOGY_SEQUENCE = Object.freeze([
  stage('core-baseline', 'initial-cold', null, CORE_BASELINE_CODE, [], [], []),
  stage('add-topology', 'dependency-change', 'native-relink-graph-transition', ADD_CODE,
    ['CKTopoA17', 'CKTopoD61'], FULL_LIBRARY_SET, ADD_ORDER),
  stage('same-graph-edit', 'same-graph-edit', 'native-relink-compile-only',
    sketch({ includeOrder: ['CKTopoA17', 'CKTopoD61'], seed: 11, useD61: true }),
    ['CKTopoA17', 'CKTopoD61'], FULL_LIBRARY_SET, ADD_ORDER),
  // AVR GCC LTO preserves library-object order in the final image. Reordering
  // literal includes therefore changes the ordered dependency topology even
  // though the unordered provider set is identical. It must regenerate the
  // graph/link manifest rather than reuse the compile-only route.
  stage('include-reorder', 'dependency-order-change', 'native-relink-graph-transition',
    sketch({ includeOrder: ['CKTopoD61', 'CKTopoA17'], seed: 11, useD61: true }),
    ['CKTopoD61', 'CKTopoA17'], FULL_LIBRARY_SET, REORDERED_ORDER),
  stage('partial-remove', 'dependency-change', 'native-relink-graph-transition',
    sketch({ includeOrder: ['CKTopoA17'], seed: 7, useD61: false }),
    ['CKTopoA17'], PARTIAL_LIBRARY_SET, PARTIAL_ORDER),
  stage('restore', 'dependency-change', 'native-relink-graph-transition', ADD_CODE,
    ['CKTopoA17', 'CKTopoD61'], FULL_LIBRARY_SET, ADD_ORDER),
]);

const NEGATIVE_SEMANTIC_CELLS = Object.freeze([
  Object.freeze({
    id: 'archive-linkage',
    property: 'dot_a_linkage=true',
    expectedRoute: 'arduino-cli-compatibility',
    requiredBehavior: 'clean-fallback-before-cli',
    executedByPositiveMatrix: false,
  }),
  Object.freeze({
    id: 'precompiled-library',
    property: 'precompiled=full',
    expectedRoute: 'arduino-cli-compatibility',
    requiredBehavior: 'clean-fallback-before-cli',
    executedByPositiveMatrix: false,
  }),
  Object.freeze({
    id: 'custom-link-flags',
    property: 'ldflags=-lck_topology_fixture',
    expectedRoute: 'arduino-cli-compatibility',
    requiredBehavior: 'clean-fallback-before-cli',
    executedByPositiveMatrix: false,
  }),
]);

function normalizedRelativePath(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\\')) {
    throw new Error(`invalid fixture relative path: ${relative}`);
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`fixture path escaped library root: ${relative}`);
  }
  return normalized;
}

function fixtureManifest() {
  const libraries = LIBRARIES.map((library) => ({
    name: library.name,
    shape: library.shape,
    depends: [...library.depends],
    translationUnits: library.translationUnits.map((relativePath) => {
      const content = library.files[relativePath];
      if (typeof content !== 'string') throw new Error(`${library.name} translation unit is missing: ${relativePath}`);
      return {
        path: relativePath,
        language: path.extname(relativePath).toLowerCase() === '.c' ? 'c' : 'cpp',
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256Bytes(content),
      };
    }),
    files: Object.entries(library.files).map(([relativePath, content]) => ({
      path: relativePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Bytes(content),
    })),
  }));
  const dependencyEdges = libraries.flatMap((library) => library.depends.map((dependency) => ({
    from: library.name,
    to: dependency,
    source: 'library.properties:depends',
  })));
  const unsigned = {
    schemaId: FIXTURE_SCHEMA_ID,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    deterministic: true,
    nameAgnostic: true,
    compileOnly: true,
    libraries,
    dependencyEdges,
    sequence: TOPOLOGY_SEQUENCE.map(({ code, ...entry }) => ({
      ...entry,
      sourceBytes: Buffer.byteLength(code, 'utf8'),
    })),
    negativeSemanticCells: NEGATIVE_SEMANTIC_CELLS,
  };
  return Object.freeze({ ...unsigned, manifestSha256: digestObject(unsigned) });
}

function assertDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return fs.realpathSync.native(resolved);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function materializeLibraries(librariesRoot, runToken) {
  if (!/^[a-f0-9]{32}$/u.test(String(runToken || ''))) {
    throw new Error('fixture installation requires a 32-character hexadecimal run token');
  }
  const root = assertDirectory(librariesRoot, 'libraries root');
  const manifest = fixtureManifest();
  const installed = [];
  try {
    for (const library of LIBRARIES) {
      const libraryRoot = path.join(root, library.name);
      if (!isInside(root, libraryRoot)) throw new Error(`${library.name} escaped libraries root`);
      if (fs.existsSync(libraryRoot)) throw new Error(`fixture destination already exists: ${libraryRoot}`);
      fs.mkdirSync(libraryRoot, { recursive: false });
      installed.push(libraryRoot);
      for (const [rawRelativePath, content] of Object.entries(library.files)) {
        const relativePath = normalizedRelativePath(rawRelativePath);
        const target = path.join(libraryRoot, ...relativePath.split('/'));
        if (!isInside(libraryRoot, target)) throw new Error(`${library.name} file escaped library root`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
      }
      const marker = {
        schemaId: FIXTURE_SCHEMA_ID,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        runToken,
        libraryName: library.name,
        manifestSha256: manifest.manifestSha256,
      };
      fs.writeFileSync(path.join(libraryRoot, OWNERSHIP_MARKER), `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    const observed = inspectMaterializedLibraries(root, runToken);
    if (observed.manifestSha256 !== manifest.manifestSha256) {
      throw new Error('materialized fixture manifest differs from deterministic fixture');
    }
    return observed;
  } catch (error) {
    for (const libraryRoot of installed.reverse()) {
      try { removeOwnedLibrary(root, libraryRoot, runToken, { allowIncomplete: true }); } catch {}
    }
    throw error;
  }
}

function readOwnershipMarker(libraryRoot, runToken) {
  const markerPath = path.join(libraryRoot, OWNERSHIP_MARKER);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('fixture marker is not a regular file');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.schemaId !== FIXTURE_SCHEMA_ID || marker.schemaVersion !== FIXTURE_SCHEMA_VERSION
      || marker.runToken !== runToken || marker.libraryName !== path.basename(libraryRoot)
      || marker.manifestSha256 !== fixtureManifest().manifestSha256) {
    throw new Error(`fixture ownership marker mismatch: ${libraryRoot}`);
  }
  return marker;
}

function inspectMaterializedLibraries(librariesRoot, runToken) {
  const root = assertDirectory(librariesRoot, 'libraries root');
  const expected = fixtureManifest();
  const libraries = expected.libraries.map((library) => {
    const libraryRoot = path.join(root, library.name);
    if (!isInside(root, libraryRoot)) throw new Error(`${library.name} escaped libraries root`);
    const realLibraryRoot = assertDirectory(libraryRoot, `${library.name} root`);
    if (!isInside(root, realLibraryRoot)) throw new Error(`${library.name} resolved outside libraries root`);
    readOwnershipMarker(realLibraryRoot, runToken);
    const files = library.files.map((expectedFile) => {
      const file = path.join(realLibraryRoot, ...normalizedRelativePath(expectedFile.path).split('/'));
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${library.name}/${expectedFile.path} is not regular`);
      const content = fs.readFileSync(file);
      const observed = { path: expectedFile.path, bytes: stat.size, sha256: sha256Bytes(content) };
      if (observed.bytes !== expectedFile.bytes || observed.sha256 !== expectedFile.sha256) {
        throw new Error(`${library.name}/${expectedFile.path} differs from deterministic fixture`);
      }
      return observed;
    });
    return { ...library, root: library.name, files };
  });
  return {
    ...expected,
    libraries,
    installedRoot: '<CK_SKETCHBOOK>/libraries',
  };
}

function removeOwnedLibrary(root, libraryRoot, runToken, { allowIncomplete = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedLibrary = path.resolve(libraryRoot);
  if (!isInside(resolvedRoot, resolvedLibrary) || !LIBRARY_NAMES.includes(path.basename(resolvedLibrary))) {
    throw new Error(`refusing to remove unowned fixture path: ${resolvedLibrary}`);
  }
  if (!fs.existsSync(resolvedLibrary)) return false;
  if (!allowIncomplete) readOwnershipMarker(resolvedLibrary, runToken);
  else {
    try { readOwnershipMarker(resolvedLibrary, runToken); } catch {
      // A failed no-clobber installation may not have written its marker yet,
      // but the directory is still a just-created exact fixture-name child.
      const entries = fs.readdirSync(resolvedLibrary, { withFileTypes: true });
      if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('incomplete fixture contains a symlink');
    }
  }
  fs.rmSync(resolvedLibrary, { recursive: true, force: false });
  return true;
}

function cleanupMaterializedLibraries(librariesRoot, runToken) {
  const root = assertDirectory(librariesRoot, 'libraries root');
  // Verify every ownership marker before deleting any path.  This avoids a
  // partial cleanup if one fixed-name destination was replaced by user data.
  for (const name of LIBRARY_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) readOwnershipMarker(candidate, runToken);
  }
  const removed = [];
  for (const name of [...LIBRARY_NAMES].reverse()) {
    const candidate = path.join(root, name);
    if (removeOwnedLibrary(root, candidate, runToken)) removed.push(name);
  }
  return { removed: removed.reverse(), remaining: LIBRARY_NAMES.filter((name) => fs.existsSync(path.join(root, name))) };
}

function recoverOwnedMaterializedLibraries(librariesRoot) {
  const root = assertDirectory(librariesRoot, 'libraries root');
  const candidates = LIBRARY_NAMES
    .map((name) => path.join(root, name))
    .filter((candidate) => fs.existsSync(candidate));
  if (candidates.length === 0) return { recovered: false, removed: [], remaining: [] };

  // Derive the run token only from a fully validated ownership marker. This
  // recovery path never accepts a token from the command line and never
  // removes an unmarked fixed-name directory.
  let runToken = null;
  for (const candidate of candidates) {
    const markerPath = path.join(candidate, OWNERSHIP_MARKER);
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error(`cannot recover unmarked fixture directory: ${candidate}`);
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!/^[a-f0-9]{32}$/u.test(String(marker.runToken || ''))) {
      throw new Error(`fixture recovery marker has an invalid run token: ${candidate}`);
    }
    readOwnershipMarker(candidate, marker.runToken);
    if (runToken == null) runToken = marker.runToken;
    else if (runToken !== marker.runToken) throw new Error('fixture recovery observed mixed run tokens');
  }
  const cleanup = cleanupMaterializedLibraries(root, runToken);
  return { recovered: true, ...cleanup };
}

function validateTopologyDefinition() {
  const manifest = fixtureManifest();
  const names = new Set(manifest.libraries.map((library) => library.name));
  if (names.size !== LIBRARIES.length || names.size !== LIBRARY_NAMES.length) return false;
  if (!manifest.libraries.some((library) => library.shape === 'modern-src-single-tu')) return false;
  if (!manifest.libraries.some((library) => library.shape === 'modern-src-deep-mixed-c-cpp'
      && new Set(library.translationUnits.map((unit) => unit.language)).size === 2)) return false;
  if (!manifest.libraries.some((library) => library.shape === 'modern-src-header-only'
      && library.translationUnits.length === 0)) return false;
  if (!manifest.dependencyEdges.some((edge) => edge.from === 'CKTopoA17' && edge.to === 'CKTopoB29')) return false;
  if (!manifest.dependencyEdges.some((edge) => edge.from === 'CKTopoB29' && edge.to === 'CKTopoC43')) return false;
  if (TOPOLOGY_SEQUENCE[1].code !== TOPOLOGY_SEQUENCE.at(-1).code) return false;
  if (TOPOLOGY_SEQUENCE[3].directLibraries.join(',') !== 'CKTopoD61,CKTopoA17') return false;
  if (TOPOLOGY_SEQUENCE[1].expectedOrderedLibraries.join(',')
      !== 'CKTopoA17,CKTopoD61,CKTopoB29,CKTopoC43') return false;
  if (TOPOLOGY_SEQUENCE[3].expectedOrderedLibraries.join(',')
      !== 'CKTopoD61,CKTopoA17,CKTopoB29,CKTopoC43') return false;
  if (TOPOLOGY_SEQUENCE[4].expectedOrderedLibraries.join(',')
      !== 'CKTopoA17,CKTopoB29,CKTopoC43') return false;
  if (!TOPOLOGY_SEQUENCE.every((entry) => (
    entry.expectedOrderedTUs.length
      === entry.expectedOrderedLibraries.reduce((count, libraryName) => {
        const library = LIBRARIES.find((candidate) => candidate.name === libraryName);
        return count + (library?.translationUnits.length || 0);
      }, 0)
  ))) return false;
  if (TOPOLOGY_SEQUENCE[3].transitionKind !== 'dependency-order-change'
      || TOPOLOGY_SEQUENCE[3].expectedRoute !== 'native-relink-graph-transition') return false;
  return TOPOLOGY_SEQUENCE.every((entry) => entry.sourceSha256 === sha256Bytes(entry.code));
}

module.exports = {
  FIXTURE_SCHEMA_ID,
  FIXTURE_SCHEMA_VERSION,
  LIBRARIES,
  LIBRARY_NAMES,
  NEGATIVE_SEMANTIC_CELLS,
  OWNERSHIP_MARKER,
  TOPOLOGY_SEQUENCE,
  canonicalJson,
  cleanupMaterializedLibraries,
  digestObject,
  fixtureManifest,
  inspectMaterializedLibraries,
  materializeLibraries,
  recoverOwnedMaterializedLibraries,
  sha256Bytes,
  validateTopologyDefinition,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--cleanup-owned') {
    if (args.length !== 2) throw new Error('--cleanup-owned requires one libraries root');
    process.stdout.write(`${JSON.stringify(recoverOwnedMaterializedLibraries(args[1]))}\n`);
  } else if (args.length === 0 || (args.length === 1 && args[0] === '--manifest')) {
    process.stdout.write(`${JSON.stringify(fixtureManifest(), null, 2)}\n`);
  } else {
    throw new Error('usage: CKAvrGenericLibraryTopologyFixtures.cjs [--manifest | --cleanup-owned <libraries-root>]');
  }
}
