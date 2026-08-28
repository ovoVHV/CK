#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  formatJsonSchemaErrors,
  loadJsonSchema,
  validateJsonSchema,
} from './JsonSchemaValidator.mjs';
import { listPackageFiles } from './Validate-ImportablePackage.mjs';

const BOARD_SCHEMA = loadJsonSchema(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'schemas',
  'ck-board.schema.json',
));

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OPTION_VALUE_RE = /^[A-Za-z0-9_.-]+$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const FQBN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SMOKE_MODES = new Set(['compile-only', 'device-upload', 'serial-runtime']);
const MATRIX_STRATEGIES = new Set(['include-only', 'bounded-pairwise']);
const SMOKE_KEYS = new Set([
  'id',
  'name',
  'description',
  'sketch',
  'mode',
  'timeout_seconds',
  'profiles',
  'requires_user_consent',
  'serial',
  'resource_limits',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Cannot compare invalid SemVer: '${left}' and '${right}'`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function versionMatchesRange(version, range) {
  if (!parseSemver(version) || !isObject(range)) return false;
  if (range.minimum && compareSemver(version, range.minimum) < 0) return false;
  if (range.maximum_exclusive && compareSemver(version, range.maximum_exclusive) >= 0) return false;
  return true;
}

function safeRelativePath(value) {
  if (!nonEmptyString(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replaceAll('\\', '/').split('/');
  return !segments.some((segment) => segment === '..' || segment === '' || segment.includes('\0'));
}

function pathIsInside(root, target) {
  const child = path.relative(root, target);
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${path.sep}`)
    && !path.isAbsolute(child)
  );
}

function resolveContainedPackageEntry(root, relativePath, label, error, expectedType = 'any') {
  if (!safeRelativePath(relativePath)) {
    error(`${label} '${relativePath}' is not a safe package-relative path.`);
    return null;
  }
  const candidate = path.resolve(root, ...relativePath.replaceAll('\\', '/').split('/'));
  if (!fs.existsSync(candidate)) {
    error(`${label} not found: ${relativePath}`);
    return null;
  }
  try {
    const lexicalRoot = path.resolve(root);
    if (!pathIsInside(lexicalRoot, candidate)) {
      error(`${label} escapes the package root: ${relativePath}`);
      return null;
    }
    const canonicalRoot = fs.realpathSync.native(lexicalRoot);
    const canonicalCandidate = fs.realpathSync.native(candidate);
    if (!pathIsInside(canonicalRoot, canonicalCandidate)) {
      error(`${label} resolves outside the package root: ${relativePath}`);
      return null;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      error(`${label} must not be a symbolic link or junction: ${relativePath}`);
      return null;
    }
    if (expectedType === 'file' && !stat.isFile()) {
      error(`${label} must be a file: ${relativePath}`);
      return null;
    }
    return candidate;
  } catch (cause) {
    error(`${label} cannot be resolved safely (${relativePath}): ${cause.message}`);
    return null;
  }
}

function validateOptionMap(value, label, error, { allowEmpty = false } = {}) {
  if (!isObject(value)) {
    error(`${label} must be an object.`);
    return false;
  }
  if (!allowEmpty && Object.keys(value).length === 0) {
    error(`${label} must be non-empty.`);
    return false;
  }
  let valid = true;
  for (const [key, optionValue] of Object.entries(value)) {
    if (!OPTION_ID_RE.test(key)) {
      error(`${label} contains invalid option key '${key}'.`);
      valid = false;
    }
    if (
      !nonEmptyString(optionValue)
      || optionValue.length > 256
      || !OPTION_VALUE_RE.test(optionValue)
    ) {
      error(
        `${label}.${key} must contain only ASCII letters, digits, '_', '-' or '.'.`,
      );
      valid = false;
    }
  }
  return valid;
}

function validateVersionRange(range, label, error) {
  if (!isObject(range) || (!range.minimum && !range.maximum_exclusive)) {
    error(`${label} must contain minimum and/or maximum_exclusive.`);
    return false;
  }
  for (const key of Object.keys(range)) {
    if (!['minimum', 'maximum_exclusive'].includes(key)) {
      error(`${label} contains unsupported field '${key}'.`);
    }
  }
  if (range.minimum && !parseSemver(range.minimum)) error(`${label}.minimum must be SemVer.`);
  if (range.maximum_exclusive && !parseSemver(range.maximum_exclusive)) {
    error(`${label}.maximum_exclusive must be SemVer.`);
  }
  if (
    parseSemver(range.minimum) &&
    parseSemver(range.maximum_exclusive) &&
    compareSemver(range.minimum, range.maximum_exclusive) >= 0
  ) {
    error(`${label}.minimum must be lower than maximum_exclusive.`);
  }
  return true;
}

function exactVersionIsKnownIncompatible(version, entries) {
  return entries.some((entry) => {
    if (!isObject(entry)) return false;
    if (entry.version === version) return true;
    return entry.version_range ? versionMatchesRange(version, entry.version_range) : false;
  });
}

export function validateBoardPackage(packageDirectory, options = {}) {
  const root = path.resolve(packageDirectory);
  const actualCoreVersion = options.actualCoreVersion;
  const errors = [];
  const warnings = [];
  const error = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);
  const manifestPath = path.join(root, 'board.json');

  let packageFiles = [];
  try {
    const listing = listPackageFiles(root);
    packageFiles = listing.files;
    errors.push(...listing.errors);
  } catch (cause) {
    error(`Board package tree cannot be read safely: ${cause.message}`);
  }
  if (!packageFiles.includes('LICENSE')) {
    error('LICENSE is required.');
  } else {
    try {
      if (!fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim()) {
        error('LICENSE must contain non-whitespace license text.');
      }
    } catch (cause) {
      error(`LICENSE cannot be read: ${cause.message}`);
    }
  }

  if (!fs.existsSync(manifestPath)) {
    return { valid: false, package: null, errors: [`board.json not found: ${manifestPath}`], warnings };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (cause) {
    return { valid: false, package: null, errors: [`board.json is invalid JSON: ${cause.message}`], warnings };
  }
  if (!isObject(manifest)) {
    return { valid: false, package: null, errors: ['board.json must contain a JSON object.'], warnings };
  }

  const schemaResult = validateJsonSchema(BOARD_SCHEMA, manifest);
  errors.push(...formatJsonSchemaErrors(schemaResult, 'board.json'));

  if (manifest.schema_version !== 1) error('schema_version must be 1.');
  if (!ID_RE.test(manifest.id ?? '')) error('id must be an ASCII path-safe package ID.');
  for (const field of ['name', 'description']) {
    if (!nonEmptyString(manifest[field])) error(`${field} must be a non-empty string.`);
  }
  if (!parseSemver(manifest.version)) error('version must be SemVer.');
  if (!FQBN_RE.test(manifest.fqbn_base ?? '')) {
    error('fqbn_base must be vendor:architecture:board without menu options.');
  }
  const fqbnParts = nonEmptyString(manifest.fqbn_base) ? manifest.fqbn_base.split(':') : [];
  if (manifest.architecture && fqbnParts.length === 3 && manifest.architecture !== fqbnParts[1]) {
    error(`architecture '${manifest.architecture}' does not match fqbn_base '${manifest.fqbn_base}'.`);
  }

  if (!isObject(manifest.arduino_core)) {
    error('arduino_core must be an object.');
  } else {
    const core = manifest.arduino_core;
    if (!nonEmptyString(core.package) || (fqbnParts.length === 3 && core.package !== `${fqbnParts[0]}:${fqbnParts[1]}`)) {
      error(`arduino_core.package must match the first two fqbn_base segments.`);
    }
    const indexUrl = core.index_url ?? core.platform_index_url;
    if (indexUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(indexUrl)) {
      error('arduino_core.index_url must be an HTTP(S) URL.');
    }
    if (nonEmptyString(core.package) && !core.package.startsWith('arduino:') && !indexUrl) {
      error('Non-Arduino cores require arduino_core.index_url or platform_index_url.');
    }
    const legacy = core.version;
    const recommended = core.recommended_version ?? legacy;
    if (!recommended) {
      error('arduino_core requires recommended_version or legacy version.');
    } else if (!parseSemver(recommended)) {
      error('arduino_core.recommended_version must be SemVer.');
    }
    if (legacy && !parseSemver(legacy)) error('arduino_core.version must be SemVer.');
    if (legacy && core.recommended_version && legacy !== core.recommended_version) {
      error('arduino_core.version and recommended_version must match when both are present.');
    }
    if (legacy && !core.recommended_version) {
      warn('arduino_core.version is a legacy recommended-version alias; add recommended_version when updating the package.');
    }
    if (core.version_range) {
      validateVersionRange(core.version_range, 'arduino_core.version_range', error);
      if (
        recommended &&
        parseSemver(recommended) &&
        core.version_range.minimum &&
        compareSemver(recommended, core.version_range.minimum) < 0
      ) {
        error('The recommended core version is below version_range.minimum.');
      }
      if (
        recommended &&
        parseSemver(recommended) &&
        core.version_range.maximum_exclusive &&
        compareSemver(recommended, core.version_range.maximum_exclusive) >= 0
      ) {
        warn('The recommended core version is above the publisher-tested range and will require revalidation.');
      }
    }
    const tested = Array.isArray(core.tested_versions) ? core.tested_versions : [];
    if (core.tested_versions !== undefined && !Array.isArray(core.tested_versions)) {
      error('arduino_core.tested_versions must be an array.');
    }
    if (new Set(tested).size !== tested.length) error('arduino_core.tested_versions contains duplicates.');
    for (const version of tested) {
      if (!parseSemver(version)) error(`arduino_core.tested_versions contains invalid SemVer '${version}'.`);
      if (
        parseSemver(version) &&
        core.version_range?.minimum &&
        compareSemver(version, core.version_range.minimum) < 0
      ) {
        error(`Tested core version '${version}' is below version_range.minimum.`);
      }
    }
    const incompatible = Array.isArray(core.known_incompatible) ? core.known_incompatible : [];
    if (core.known_incompatible !== undefined && !Array.isArray(core.known_incompatible)) {
      error('arduino_core.known_incompatible must be an array.');
    }
    incompatible.forEach((entry, index) => {
      const label = `arduino_core.known_incompatible[${index}]`;
      if (!isObject(entry)) {
        error(`${label} must be an object.`);
        return;
      }
      if (!nonEmptyString(entry.reason)) error(`${label}.reason is required.`);
      if ((entry.version ? 1 : 0) + (entry.version_range ? 1 : 0) !== 1) {
        error(`${label} must contain exactly one of version or version_range.`);
      }
      if (entry.version && !parseSemver(entry.version)) error(`${label}.version must be SemVer.`);
      if (entry.version_range) validateVersionRange(entry.version_range, `${label}.version_range`, error);
    });
    if (recommended && exactVersionIsKnownIncompatible(recommended, incompatible)) {
      error('The recommended core version is also declared known_incompatible.');
    }
    for (const version of tested) {
      if (parseSemver(version) && exactVersionIsKnownIncompatible(version, incompatible)) {
        error(`Tested core version '${version}' is also declared known_incompatible.`);
      }
    }
    if (actualCoreVersion !== undefined) {
      if (!parseSemver(actualCoreVersion)) {
        error(`Actual core version '${actualCoreVersion}' is not valid SemVer.`);
      } else {
        const belowMinimum =
          core.version_range?.minimum &&
          compareSemver(actualCoreVersion, core.version_range.minimum) < 0;
        const explicitlyIncompatible = exactVersionIsKnownIncompatible(actualCoreVersion, incompatible);
        if (belowMinimum) {
          error(
            `Actual core version ${actualCoreVersion} is below the hard minimum ${core.version_range.minimum}.`,
          );
        }
        if (explicitlyIncompatible) {
          error(`Actual core version ${actualCoreVersion} is explicitly known_incompatible.`);
        }
        const isRecommended = actualCoreVersion === recommended;
        const isTested = tested.includes(actualCoreVersion);
        if (!belowMinimum && !explicitlyIncompatible && !isRecommended && !isTested) {
          if (
            core.version_range?.maximum_exclusive &&
            compareSemver(actualCoreVersion, core.version_range.maximum_exclusive) >= 0
          ) {
            warn(
              `Actual core version ${actualCoreVersion} is at or above the publisher-tested upper edge; it is allowed but requires revalidation.`,
            );
          } else {
            warn(
              `Actual core version ${actualCoreVersion} is untested; it is allowed but requires revalidation.`,
            );
          }
        }
      }
    }
  }

  if (manifest.icon) {
    resolveContainedPackageEntry(root, manifest.icon, 'icon file', error, 'file');
  }
  if (manifest.extends) {
    resolveContainedPackageEntry(root, manifest.extends, 'extends path', error);
  }

  if (manifest.capabilities !== undefined) {
    if (!isObject(manifest.capabilities)) {
      error('capabilities must be an object.');
    } else {
      for (const [key, value] of Object.entries(manifest.capabilities)) {
        if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || typeof value !== 'boolean') {
          error(`capabilities.${key} must use a lower-case capability ID and boolean value.`);
        }
      }
    }
  }

  if (manifest.pins === undefined || (Array.isArray(manifest.pins) && manifest.pins.length === 0)) {
    warn('pins:not_declared — no pin catalog was declared; pin search and hardware-resource checks remain unknown.');
  } else if (Array.isArray(manifest.pins)) {
    const occupiedTokens = new Map();
    const supportedPinRiskFeatures = new Set(['wifi']);
    manifest.pins.forEach((pin, index) => {
      if (!isObject(pin)) return;
      const tokens = [pin.value, ...(Array.isArray(pin.aliases) ? pin.aliases : [])]
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim().toLocaleLowerCase('en-US'));
      for (const token of tokens) {
        if (occupiedTokens.has(token)) {
          error(`pins[${index}] token '${token}' conflicts with pins[${occupiedTokens.get(token)}].`);
        } else occupiedTokens.set(token, index);
      }
      for (const [riskIndex, risk] of (Array.isArray(pin.risks) ? pin.risks : []).entries()) {
        const features = risk?.when?.features;
        if (!Array.isArray(features)) continue;
        for (const feature of features) {
          if (!supportedPinRiskFeatures.has(feature)) {
            error(`pins[${index}].risks[${riskIndex}].when.features contains unsupported feature '${feature}'.`);
          }
        }
      }
    });
    const detailed = manifest.pins.every(pin => (
      isObject(pin)
      && Array.isArray(pin.aliases) && pin.aliases.length > 0
      && Array.isArray(pin.capabilities) && pin.capabilities.length > 0
      && typeof pin.sharing === 'string'
      && typeof pin.source === 'string' && pin.source.trim()
      && Array.isArray(pin.evidence) && pin.evidence.length > 0
    ));
    if (!detailed) {
      warn('pins:basic_only — pin entries are importable but lack complete aliases/capabilities/sharing/source/evidence metadata.');
    }
  }

  const customMenus = isObject(manifest.custom_menus) ? manifest.custom_menus : {};
  const menuValues = new Map();
  for (const [menuId, menu] of Object.entries(customMenus)) {
    if (!OPTION_ID_RE.test(menuId) || !isObject(menu) || !Array.isArray(menu.options) || menu.options.length === 0) {
      error(`custom_menus.${menuId} must define a non-empty options array.`);
      continue;
    }
    const values = menu.options.map((entry) => entry?.value);
    if (values.some((value) => !nonEmptyString(value) || !OPTION_VALUE_RE.test(value))) {
      error(`custom_menus.${menuId} contains a value outside [A-Za-z0-9_.-].`);
    }
    if (new Set(values).size !== values.length) error(`custom_menus.${menuId} contains duplicate values.`);
    if (menu.selected && !values.includes(menu.selected)) error(`custom_menus.${menuId}.selected is not an option.`);
    menuValues.set(menuId, new Set(values));
  }

  const variants = Array.isArray(manifest.hardware_variants) ? manifest.hardware_variants : [];
  const profiles = Array.isArray(manifest.validation_profiles) ? manifest.validation_profiles : [];
  const smokes = Array.isArray(manifest.smoke_tests) ? manifest.smoke_tests : [];
  const usesPassport =
    manifest.hardware_variants !== undefined ||
    manifest.validation_profiles !== undefined ||
    manifest.smoke_tests !== undefined ||
    manifest.validation_matrix !== undefined;
  if (usesPassport && (variants.length === 0 || profiles.length === 0 || smokes.length === 0)) {
    error('Board passport declarations require non-empty hardware_variants, validation_profiles and smoke_tests together.');
  }

  const variantIds = new Set();
  for (const [index, variant] of variants.entries()) {
    const label = `hardware_variants[${index}]`;
    if (!isObject(variant) || !ID_RE.test(variant.id ?? '')) {
      error(`${label}.id must be a valid ID.`);
      continue;
    }
    if (variantIds.has(variant.id)) error(`Duplicate hardware variant id '${variant.id}'.`);
    variantIds.add(variant.id);
    if (!nonEmptyString(variant.name)) error(`${label}.name is required.`);
    if (!isObject(variant.expected_hardware)) {
      error(`${label}.expected_hardware is required.`);
    } else {
      if (!nonEmptyString(variant.expected_hardware.chip)) error(`${label}.expected_hardware.chip is required.`);
      if (!Number.isInteger(variant.expected_hardware.flash_bytes) || variant.expected_hardware.flash_bytes < 1024) {
        error(`${label}.expected_hardware.flash_bytes must be an integer of at least 1024.`);
      }
      if (
        variant.expected_hardware.psram_bytes !== undefined &&
        (!Number.isInteger(variant.expected_hardware.psram_bytes) || variant.expected_hardware.psram_bytes < 0)
      ) {
        error(`${label}.expected_hardware.psram_bytes must be a non-negative integer.`);
      }
    }
    if (!ID_RE.test(variant.default_profile ?? '')) error(`${label}.default_profile is required.`);
    if (variant.fixed_options) validateOptionMap(variant.fixed_options, `${label}.fixed_options`, error);
  }
  if (variants.filter((variant) => variant?.default === true).length > 1) {
    error('Only one hardware variant may be marked default.');
  }

  const profileById = new Map();
  let canonicalProfileKeys = null;
  for (const [index, profile] of profiles.entries()) {
    const label = `validation_profiles[${index}]`;
    if (!isObject(profile) || !ID_RE.test(profile.id ?? '')) {
      error(`${label}.id must be a valid ID.`);
      continue;
    }
    if (profileById.has(profile.id)) error(`Duplicate validation profile id '${profile.id}'.`);
    profileById.set(profile.id, profile);
    if (!nonEmptyString(profile.name)) error(`${label}.name is required.`);
    if (!variantIds.has(profile.hardware_variant)) {
      error(`${label}.hardware_variant '${profile.hardware_variant}' does not exist.`);
    }
    if (profile.options_complete !== true) error(`${label}.options_complete must be true.`);
    if (validateOptionMap(
      profile.options,
      `${label}.options`,
      error,
      { allowEmpty: menuValues.size === 0 },
    )) {
      const keys = Object.keys(profile.options).sort();
      if (canonicalProfileKeys === null) canonicalProfileKeys = keys;
      else if (keys.join('\0') !== canonicalProfileKeys.join('\0')) {
        error(`${label}.options must contain the same complete option keys as other profiles.`);
      }
      for (const [option, value] of Object.entries(profile.options)) {
        if (menuValues.has(option) && !menuValues.get(option).has(value)) {
          error(`${label}.options.${option} value '${value}' is absent from custom_menus.`);
        }
      }
    }
    if (!Array.isArray(profile.smoke_tests) || profile.smoke_tests.length === 0) {
      error(`${label}.smoke_tests must be a non-empty array.`);
    }
  }
  for (const variant of variants) {
    const profile = profileById.get(variant.default_profile);
    if (!profile) {
      error(`Hardware variant '${variant.id}' references missing default_profile '${variant.default_profile}'.`);
      continue;
    }
    if (profile.hardware_variant !== variant.id) {
      error(`Hardware variant '${variant.id}' default profile belongs to '${profile.hardware_variant}'.`);
    }
    for (const candidate of profiles.filter((item) => item?.hardware_variant === variant.id)) {
      for (const [option, value] of Object.entries(variant.fixed_options ?? {})) {
        if (candidate.options?.[option] !== value) {
          error(`Profile '${candidate.id}' violates fixed option ${option}=${value} for variant '${variant.id}'.`);
        }
      }
    }
  }

  const smokeById = new Map();
  for (const [index, smoke] of smokes.entries()) {
    const label = `smoke_tests[${index}]`;
    if (!isObject(smoke) || !ID_RE.test(smoke.id ?? '')) {
      error(`${label}.id must be a valid ID.`);
      continue;
    }
    if (smokeById.has(smoke.id)) error(`Duplicate smoke test id '${smoke.id}'.`);
    smokeById.set(smoke.id, smoke);
    for (const key of Object.keys(smoke)) {
      if (!SMOKE_KEYS.has(key)) {
        error(`${label} contains unsupported field '${key}'; smoke tests cannot run arbitrary commands.`);
      }
    }
    if (!nonEmptyString(smoke.name)) error(`${label}.name is required.`);
    if (!SMOKE_MODES.has(smoke.mode)) error(`${label}.mode is not supported.`);
    if (!Number.isInteger(smoke.timeout_seconds) || smoke.timeout_seconds < 1 || smoke.timeout_seconds > 900) {
      error(`${label}.timeout_seconds must be an integer from 1 to 900.`);
    }
    if (smoke.resource_limits !== undefined) {
      if (!isObject(smoke.resource_limits)) {
        error(`${label}.resource_limits must be an object.`);
      } else {
        const allowedLimits = new Set(['max_flash_bytes', 'max_ram_bytes', 'max_warnings']);
        for (const [key, value] of Object.entries(smoke.resource_limits)) {
          if (!allowedLimits.has(key)) {
            error(`${label}.resource_limits contains unsupported field '${key}'.`);
          } else if (
            key === 'max_warnings'
              ? !Number.isInteger(value) || value < 0 || value > 10000
              : !Number.isInteger(value) || value < 1
          ) {
            error(
              `${label}.resource_limits.${key} must be ${
                key === 'max_warnings' ? 'an integer from 0 to 10000' : 'a positive integer'
              }.`,
            );
          }
        }
      }
    }
    const sketchPath = resolveContainedPackageEntry(
      root,
      smoke.sketch,
      `${label}.sketch`,
      error,
      'file',
    );
    if (sketchPath) {
      if (path.extname(sketchPath).toLowerCase() !== '.ino') error(`${label}.sketch must be an .ino file.`);
      if (path.basename(sketchPath, '.ino') !== path.basename(path.dirname(sketchPath))) {
        error(`${label}.sketch folder and .ino base name must match for Arduino CLI.`);
      }
    }
    if (smoke.profiles) {
      if (!Array.isArray(smoke.profiles) || smoke.profiles.length === 0) error(`${label}.profiles must be non-empty.`);
      else for (const profileId of smoke.profiles) {
        if (!profileById.has(profileId)) error(`${label} references missing profile '${profileId}'.`);
      }
    }
    if (smoke.mode !== 'compile-only' && smoke.requires_user_consent !== true) {
      error(`${label} must set requires_user_consent=true for device access.`);
    }
    if (smoke.mode === 'serial-runtime') {
      if (!isObject(smoke.serial)) error(`${label}.serial is required for serial-runtime.`);
      else {
        if (!Number.isInteger(smoke.serial.baud_rate)) error(`${label}.serial.baud_rate must be an integer.`);
        if (!Number.isInteger(smoke.serial.timeout_seconds) || smoke.serial.timeout_seconds < 1 || smoke.serial.timeout_seconds > 120) {
          error(`${label}.serial.timeout_seconds must be from 1 to 120.`);
        }
        if (!nonEmptyString(smoke.serial.success_token) || /[\r\n]/.test(smoke.serial.success_token)) {
          error(`${label}.serial.success_token must be one line of text.`);
        }
      }
    }
  }
  for (const profile of profiles) {
    for (const smokeId of profile.smoke_tests ?? []) {
      if (!smokeById.has(smokeId)) error(`Profile '${profile.id}' references missing smoke test '${smokeId}'.`);
      const allowedProfiles = smokeById.get(smokeId)?.profiles;
      if (Array.isArray(allowedProfiles) && !allowedProfiles.includes(profile.id)) {
        error(`Profile '${profile.id}' uses smoke test '${smokeId}', but that test does not list the profile.`);
      }
    }
  }

  if (manifest.validation_matrix !== undefined) {
    const matrix = manifest.validation_matrix;
    if (!isObject(matrix)) {
      error('validation_matrix must be an object.');
    } else {
      if (!MATRIX_STRATEGIES.has(matrix.strategy)) error('validation_matrix.strategy is not supported.');
      if (!Number.isInteger(matrix.max_cases) || matrix.max_cases < 1 || matrix.max_cases > 64) {
        error('validation_matrix.max_cases must be an integer from 1 to 64.');
      }
      const groups = Array.isArray(matrix.groups) ? matrix.groups : [];
      const groupIds = new Set();
      for (const [index, group] of groups.entries()) {
        const label = `validation_matrix.groups[${index}]`;
        if (!isObject(group) || !ID_RE.test(group.id ?? '')) {
          error(`${label}.id must be a valid ID.`);
          continue;
        }
        if (groupIds.has(group.id)) error(`Duplicate validation matrix group '${group.id}'.`);
        groupIds.add(group.id);
        const base = profileById.get(group.base_profile);
        if (!base) error(`${label}.base_profile '${group.base_profile}' does not exist.`);
        if (!isObject(group.dimensions) || Object.keys(group.dimensions).length === 0) {
          error(`${label}.dimensions must be a non-empty object.`);
        } else {
          for (const [option, values] of Object.entries(group.dimensions)) {
            if (!OPTION_ID_RE.test(option) || !Array.isArray(values) || values.length === 0) {
              error(`${label}.dimensions.${option} must be a non-empty value array.`);
              continue;
            }
            if (
              new Set(values).size !== values.length
              || values.some((value) => !nonEmptyString(value) || !OPTION_VALUE_RE.test(value))
            ) {
              error(`${label}.dimensions.${option} contains empty or duplicate values.`);
            }
            if (base && !(option in base.options)) error(`${label} dimension '${option}' is absent from the complete base profile.`);
            if (menuValues.has(option)) {
              for (const value of values) {
                if (!menuValues.get(option).has(value)) error(`${label} uses undeclared menu value ${option}=${value}.`);
              }
            }
          }
        }
        for (const smokeId of group.smoke_tests ?? []) {
          if (!smokeById.has(smokeId)) error(`${label} references missing smoke test '${smokeId}'.`);
        }
      }
      if (matrix.strategy === 'bounded-pairwise' && groups.length === 0) {
        error('bounded-pairwise validation_matrix requires groups.');
      }
      const includes = Array.isArray(matrix.include) ? matrix.include : [];
      if (matrix.strategy === 'include-only' && includes.length === 0) {
        error('include-only validation_matrix requires include cases.');
      }
      if (Number.isInteger(matrix.max_cases) && includes.length > matrix.max_cases) {
        error('validation_matrix.include has more cases than max_cases.');
      }
      for (const [index, entry] of includes.entries()) {
        const label = `validation_matrix.include[${index}]`;
        if (!isObject(entry)) {
          error(`${label} must be an object.`);
          continue;
        }
        const direct = Boolean(entry.profile);
        const derived = Boolean(entry.base_profile) && Boolean(entry.options);
        if (direct === derived) error(`${label} must select either profile or base_profile + options.`);
        if (entry.profile && !profileById.has(entry.profile)) error(`${label}.profile '${entry.profile}' does not exist.`);
        if (entry.base_profile && !profileById.has(entry.base_profile)) {
          error(`${label}.base_profile '${entry.base_profile}' does not exist.`);
        }
        if (entry.options) validateOptionMap(entry.options, `${label}.options`, error);
        for (const smokeId of entry.smoke_tests ?? []) {
          if (!smokeById.has(smokeId)) error(`${label} references missing smoke test '${smokeId}'.`);
        }
      }
      const excludes = Array.isArray(matrix.exclude) ? matrix.exclude : [];
      for (const [index, entry] of excludes.entries()) {
        const label = `validation_matrix.exclude[${index}]`;
        if (!isObject(entry)) {
          error(`${label} must be an object.`);
          continue;
        }
        if (!nonEmptyString(entry.reason)) error(`${label}.reason is required.`);
        validateOptionMap(entry.when, `${label}.when`, error);
        if (entry.group && !groupIds.has(entry.group)) error(`${label}.group '${entry.group}' does not exist.`);
        if (entry.base_profile && !profileById.has(entry.base_profile)) {
          error(`${label}.base_profile '${entry.base_profile}' does not exist.`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    package: manifest.id ?? null,
    errors,
    warnings,
    counts: {
      hardware_variants: variants.length,
      validation_profiles: profiles.length,
      smoke_tests: smokes.length,
    },
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const coreVersionIndex = args.indexOf('--core-version');
  const actualCoreVersion = coreVersionIndex >= 0 ? args[coreVersionIndex + 1] : undefined;
  const positional = args.filter((arg, index) => {
    if (arg === '--json' || arg === '--core-version') return false;
    if (coreVersionIndex >= 0 && index === coreVersionIndex + 1) return false;
    return true;
  });
  const packageDirectory = positional[0];
  if (!packageDirectory) {
    console.error(
      'Usage: node scripts/Validate-BoardPackage.mjs <package-directory> [--core-version <semver>] [--json]',
    );
    process.exitCode = 2;
    return;
  }
  if (coreVersionIndex >= 0 && actualCoreVersion === undefined) {
    console.error('--core-version requires a SemVer value.');
    process.exitCode = 2;
    return;
  }
  const report = validateBoardPackage(packageDirectory, { actualCoreVersion });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const message of report.warnings) console.warn(`[WARN] ${message}`);
    for (const message of report.errors) console.error(`[ERROR] ${message}`);
    if (report.valid) {
      console.log(
        `[PASS] ${report.package}: ${report.counts.hardware_variants} hardware variant(s), ` +
          `${report.counts.validation_profiles} profile(s), ${report.counts.smoke_tests} smoke test(s).`,
      );
    }
  }
  if (!report.valid) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) runCli();
