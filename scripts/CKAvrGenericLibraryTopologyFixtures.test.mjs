import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fixtures = require('./CKAvrGenericLibraryTopologyFixtures.cjs');

test('fixture topology is deterministic and covers generic Arduino library shapes', () => {
  assert.equal(fixtures.validateTopologyDefinition(), true);
  const first = fixtures.fixtureManifest();
  const second = fixtures.fixtureManifest();
  assert.deepEqual(first, second);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.nameAgnostic, true);
  assert.equal(first.compileOnly, true);
  assert.deepEqual(first.dependencyEdges, [
    { from: 'CKTopoA17', to: 'CKTopoB29', source: 'library.properties:depends' },
    { from: 'CKTopoB29', to: 'CKTopoC43', source: 'library.properties:depends' },
  ]);

  const mixed = first.libraries.find((library) => library.name === 'CKTopoB29');
  assert.deepEqual(mixed.translationUnits.map((unit) => [unit.path, unit.language]), [
    ['src/CKTopoB29.cpp', 'cpp'],
    ['src/nested/CKTopoB29Detail.c', 'c'],
  ]);
  assert.ok(mixed.translationUnits.every((unit) => /^[0-9a-f]{64}$/u.test(unit.sha256)));
  const headerOnly = first.libraries.find((library) => library.name === 'CKTopoC43');
  assert.equal(headerOnly.shape, 'modern-src-header-only');
  assert.deepEqual(headerOnly.translationUnits, []);
});

test('sequence exercises add, edit, include reorder, partial remove and exact restore', () => {
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE.map((stage) => stage.id), [
    'core-baseline',
    'add-topology',
    'same-graph-edit',
    'include-reorder',
    'partial-remove',
    'restore',
  ]);
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE.map((stage) => stage.expectedRoute), [
    null,
    'native-relink-graph-transition',
    'native-relink-compile-only',
    'native-relink-graph-transition',
    'native-relink-graph-transition',
    'native-relink-graph-transition',
  ]);
  assert.equal(fixtures.TOPOLOGY_SEQUENCE[3].transitionKind, 'dependency-order-change');
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE[1].directLibraries, ['CKTopoA17', 'CKTopoD61']);
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE[3].directLibraries, ['CKTopoD61', 'CKTopoA17']);
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE[4].expectedLibrarySet, [
    'CKTopoA17', 'CKTopoB29', 'CKTopoC43',
  ]);
  assert.deepEqual(fixtures.TOPOLOGY_SEQUENCE.map((stage) => stage.expectedOrderedLibraries), [
    [],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoD61', 'CKTopoA17', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
  ]);
  assert.deepEqual(
    fixtures.TOPOLOGY_SEQUENCE[3].expectedOrderedTUs.map(
      ({ library, sourceRelativePath }) => `${library}/${sourceRelativePath}`,
    ),
    [
      'CKTopoD61/src/CKTopoD61.cpp',
      'CKTopoA17/src/CKTopoA17.cpp',
      'CKTopoB29/src/CKTopoB29.cpp',
      'CKTopoB29/src/nested/CKTopoB29Detail.c',
    ],
  );
  assert.deepEqual(
    fixtures.TOPOLOGY_SEQUENCE[3].expectedCcdbObservableLibraryOrder,
    ['CKTopoD61', 'CKTopoA17', 'CKTopoB29'],
    'header-only CKTopoC43 is part of the library graph but has no CCDB TU',
  );
  assert.equal(fixtures.TOPOLOGY_SEQUENCE[1].code, fixtures.TOPOLOGY_SEQUENCE.at(-1).code);
});

test('negative semantics require a clean Arduino CLI compatibility fallback', () => {
  assert.deepEqual(fixtures.NEGATIVE_SEMANTIC_CELLS.map((cell) => cell.id), [
    'archive-linkage',
    'precompiled-library',
    'custom-link-flags',
  ]);
  assert.ok(fixtures.NEGATIVE_SEMANTIC_CELLS.every((cell) => (
    cell.expectedRoute === 'arduino-cli-compatibility'
    && cell.requiredBehavior === 'clean-fallback-before-cli'
    && cell.executedByPositiveMatrix === false
  )));
});

test('materialization is no-clobber, byte-audited, marker-owned and fully cleaned', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-topology-fixture-test-'));
  const librariesRoot = path.join(parent, 'libraries');
  fs.mkdirSync(librariesRoot);
  const token = '0123456789abcdef0123456789abcdef';
  try {
    const installed = fixtures.materializeLibraries(librariesRoot, token);
    assert.equal(installed.manifestSha256, fixtures.fixtureManifest().manifestSha256);
    assert.deepEqual(installed.libraries.map((library) => library.root), fixtures.LIBRARY_NAMES);
    for (const library of installed.libraries) {
      assert.ok(fs.statSync(path.join(librariesRoot, library.root, fixtures.OWNERSHIP_MARKER)).isFile());
    }
    assert.throws(
      () => fixtures.materializeLibraries(librariesRoot, token),
      /destination already exists/u,
    );
    const observed = fixtures.inspectMaterializedLibraries(librariesRoot, token);
    assert.deepEqual(
      observed.libraries.flatMap((library) => library.translationUnits.map((unit) => unit.sha256)),
      fixtures.fixtureManifest().libraries.flatMap(
        (library) => library.translationUnits.map((unit) => unit.sha256),
      ),
    );
    const cleanup = fixtures.recoverOwnedMaterializedLibraries(librariesRoot);
    assert.equal(cleanup.recovered, true);
    assert.deepEqual(cleanup.removed, fixtures.LIBRARY_NAMES);
    assert.deepEqual(cleanup.remaining, []);
    assert.deepEqual(fs.readdirSync(librariesRoot), []);
    assert.deepEqual(fixtures.recoverOwnedMaterializedLibraries(librariesRoot), {
      recovered: false,
      removed: [],
      remaining: [],
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cleanup refuses a replaced or unowned fixed-name destination', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-topology-fixture-owner-test-'));
  const librariesRoot = path.join(parent, 'libraries');
  fs.mkdirSync(librariesRoot);
  const token = 'abcdef0123456789abcdef0123456789';
  try {
    fixtures.materializeLibraries(librariesRoot, token);
    const marker = path.join(librariesRoot, fixtures.LIBRARY_NAMES[0], fixtures.OWNERSHIP_MARKER);
    fs.writeFileSync(marker, '{"replaced":true}\n', 'utf8');
    assert.throws(
      () => fixtures.cleanupMaterializedLibraries(librariesRoot, token),
      /ownership marker mismatch/u,
    );
    assert.ok(fs.existsSync(path.join(librariesRoot, fixtures.LIBRARY_NAMES.at(-1))));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
