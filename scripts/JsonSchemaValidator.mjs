import { readFileSync } from 'node:fs';

const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'default', '$comment',
  'examples', 'deprecated', 'readOnly', 'writeOnly',
]);
const ASSERTION_KEYWORDS = new Set([
  '$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength',
  'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'items', 'prefixItems',
  'contains', 'minContains', 'maxContains', 'minProperties', 'maxProperties',
  'propertyNames', 'properties', 'patternProperties', 'additionalProperties',
  'required', 'dependentRequired', 'allOf', 'anyOf', 'oneOf', 'not', 'if',
  'then', 'else',
]);
const KNOWN_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(left, right) {
  return canonical(left) === canonical(right);
}

function pointerToken(value) {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function resolveLocalJsonPointer(rootSchema, reference) {
  if (reference === '#') return rootSchema;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new Error(`only local JSON Schema references are supported: ${String(reference)}`);
  }
  let current = rootSchema;
  for (const segment of reference.slice(2).split('/').map(pointerToken)) {
    if ((!isObject(current) && !Array.isArray(current)) || !own(current, segment)) {
      throw new Error(`unresolved local JSON Schema reference: ${reference}`);
    }
    current = current[segment];
  }
  return current;
}

function schemaError(path, keyword, message) {
  return { kind: 'schema', schema_path: path, instance_path: '$', keyword, message };
}

function dataError(instancePath, schemaPath, keyword, message) {
  return { kind: 'instance', schema_path: schemaPath, instance_path: instancePath, keyword, message };
}

function auditSchema(rootSchema) {
  const errors = [];
  const visited = new Set();
  const visit = (schema, path) => {
    if (typeof schema === 'boolean') return;
    if (!isObject(schema)) {
      errors.push(schemaError(path, 'schema', 'schema must be an object or boolean'));
      return;
    }
    if (visited.has(schema)) return;
    visited.add(schema);
    for (const key of Object.keys(schema)) {
      if (!ANNOTATION_KEYWORDS.has(key) && !ASSERTION_KEYWORDS.has(key)) {
        errors.push(schemaError(`${path}/${key}`, key, `unsupported JSON Schema keyword '${key}'`));
      }
    }
    if (own(schema, '$ref')) {
      if (typeof schema.$ref !== 'string') errors.push(schemaError(`${path}/$ref`, '$ref', '$ref must be a string'));
      else {
        try {
          visit(resolveLocalJsonPointer(rootSchema, schema.$ref), `${path}/$ref(${schema.$ref})`);
        } catch (error) {
          errors.push(schemaError(`${path}/$ref`, '$ref', error.message));
        }
      }
    }
    if (own(schema, 'type')) {
      const values = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (values.length === 0 || values.some(value => !KNOWN_TYPES.has(value)) || new Set(values).size !== values.length) {
        errors.push(schemaError(`${path}/type`, 'type', 'type must contain unique supported JSON types'));
      }
    }
    if (own(schema, 'enum') && (
      !Array.isArray(schema.enum)
      || schema.enum.length === 0
      || new Set((schema.enum ?? []).map(canonical)).size !== (schema.enum ?? []).length
    )) {
      errors.push(schemaError(`${path}/enum`, 'enum', 'enum must be a non-empty array of unique JSON values'));
    }
    if (own(schema, 'pattern')) {
      if (typeof schema.pattern !== 'string') errors.push(schemaError(`${path}/pattern`, 'pattern', 'pattern must be a string'));
      else try { new RegExp(schema.pattern, 'u'); } catch (error) {
          errors.push(schemaError(`${path}/pattern`, 'pattern', `invalid regular expression: ${error.message}`));
        }
    }
    if (own(schema, 'format') && (typeof schema.format !== 'string' || !['date-time', 'uri'].includes(schema.format))) {
      errors.push(schemaError(`${path}/format`, 'format', `unsupported format '${schema.format}'`));
    }
    for (const key of [
      'minLength', 'maxLength', 'minItems', 'maxItems', 'minContains',
      'maxContains', 'minProperties', 'maxProperties',
    ]) {
      if (own(schema, key) && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
        errors.push(schemaError(`${path}/${key}`, key, `${key} must be a non-negative integer`));
      }
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
      if (own(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
        errors.push(schemaError(`${path}/${key}`, key, `${key} must be a finite number`));
      }
    }
    if (own(schema, 'multipleOf') && schema.multipleOf <= 0) {
      errors.push(schemaError(`${path}/multipleOf`, 'multipleOf', 'multipleOf must be greater than zero'));
    }
    for (const [minimum, maximum] of [
      ['minLength', 'maxLength'], ['minItems', 'maxItems'],
      ['minContains', 'maxContains'], ['minProperties', 'maxProperties'],
    ]) {
      if (own(schema, minimum) && own(schema, maximum) && schema[minimum] > schema[maximum]) {
        errors.push(schemaError(path, minimum, `${minimum} cannot exceed ${maximum}`));
      }
    }
    if (own(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') {
      errors.push(schemaError(`${path}/uniqueItems`, 'uniqueItems', 'uniqueItems must be a boolean'));
    }
    if ((own(schema, 'minContains') || own(schema, 'maxContains')) && !own(schema, 'contains')) {
      errors.push(schemaError(path, 'contains', 'minContains/maxContains require contains'));
    }
    if (own(schema, 'required') && (
      !Array.isArray(schema.required)
      || schema.required.some(value => typeof value !== 'string')
      || new Set(schema.required).size !== schema.required.length
    )) errors.push(schemaError(`${path}/required`, 'required', 'required must be an array of unique strings'));

    const visitMap = (key) => {
      if (!own(schema, key)) return;
      if (!isObject(schema[key])) {
        errors.push(schemaError(`${path}/${key}`, key, `${key} must be an object of schemas`));
        return;
      }
      for (const [name, child] of Object.entries(schema[key])) visit(child, `${path}/${key}/${name}`);
    };
    visitMap('$defs');
    visitMap('properties');
    visitMap('patternProperties');
    if (isObject(schema.patternProperties)) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        try { new RegExp(pattern, 'u'); } catch (error) {
          errors.push(schemaError(`${path}/patternProperties/${pattern}`, 'patternProperties', `invalid property pattern: ${error.message}`));
        }
      }
    }
    if (own(schema, 'dependentRequired')) {
      if (!isObject(schema.dependentRequired)) {
        errors.push(schemaError(`${path}/dependentRequired`, 'dependentRequired', 'dependentRequired must be an object'));
      } else {
        for (const [key, required] of Object.entries(schema.dependentRequired)) {
          if (!Array.isArray(required) || required.some(value => typeof value !== 'string') || new Set(required).size !== required.length) {
            errors.push(schemaError(`${path}/dependentRequired/${key}`, 'dependentRequired', 'dependentRequired entries must be unique string arrays'));
          }
        }
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (!own(schema, key)) continue;
      if (!Array.isArray(schema[key]) || (key !== 'prefixItems' && schema[key].length === 0)) {
        errors.push(schemaError(`${path}/${key}`, key, `${key} must be ${key === 'prefixItems' ? 'an array' : 'a non-empty array'}`));
      } else schema[key].forEach((child, index) => visit(child, `${path}/${key}/${index}`));
    }
    for (const key of ['items', 'contains', 'propertyNames', 'additionalProperties', 'not', 'if', 'then', 'else']) {
      if (own(schema, key)) visit(schema[key], `${path}/${key}`);
    }
  };
  visit(rootSchema, '#');
  return errors;
}

function hasType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validUri(value) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}

function validateInstance(rootSchema, schema, value, instancePath, schemaPath) {
  if (schema === true) return [];
  if (schema === false) return [dataError(instancePath, schemaPath, 'falseSchema', 'rejected by false schema')];
  const errors = [];
  const check = (candidate, candidateValue = value, candidatePath = instancePath, candidateSchemaPath = schemaPath) => (
    validateInstance(rootSchema, candidate, candidateValue, candidatePath, candidateSchemaPath)
  );
  const valid = (candidate, candidateValue = value) => check(candidate, candidateValue).length === 0;
  if (own(schema, '$ref')) {
    errors.push(...check(resolveLocalJsonPointer(rootSchema, schema.$ref), value, instancePath, `${schemaPath}/$ref(${schema.$ref})`));
  }
  for (const [keyword, candidates] of [['allOf', schema.allOf ?? []]]) {
    candidates.forEach((candidate, index) => errors.push(...check(candidate, value, instancePath, `${schemaPath}/${keyword}/${index}`)));
  }
  if (schema.anyOf && !schema.anyOf.some(candidate => valid(candidate))) {
    errors.push(dataError(instancePath, `${schemaPath}/anyOf`, 'anyOf', 'does not match any branch'));
  }
  if (schema.oneOf && schema.oneOf.filter(candidate => valid(candidate)).length !== 1) {
    errors.push(dataError(instancePath, `${schemaPath}/oneOf`, 'oneOf', 'does not match exactly one branch'));
  }
  if (schema.not && valid(schema.not)) errors.push(dataError(instancePath, `${schemaPath}/not`, 'not', 'matches forbidden schema'));
  if (schema.if) {
    const condition = valid(schema.if);
    if (condition && schema.then) errors.push(...check(schema.then, value, instancePath, `${schemaPath}/then`));
    if (!condition && schema.else) errors.push(...check(schema.else, value, instancePath, `${schemaPath}/else`));
  }
  if (own(schema, 'const') && !deepEqual(value, schema.const)) errors.push(dataError(instancePath, `${schemaPath}/const`, 'const', 'does not equal const'));
  if (schema.enum && !schema.enum.some(item => deepEqual(value, item))) errors.push(dataError(instancePath, `${schemaPath}/enum`, 'enum', 'is not an allowed value'));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => hasType(value, type))) {
      errors.push(dataError(instancePath, `${schemaPath}/type`, 'type', `expected ${types.join(' or ')}`));
      return errors;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(dataError(instancePath, `${schemaPath}/minLength`, 'minLength', 'string is too short'));
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(dataError(instancePath, `${schemaPath}/maxLength`, 'maxLength', 'string is too long'));
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(dataError(instancePath, `${schemaPath}/pattern`, 'pattern', 'string does not match pattern'));
    if (schema.format === 'date-time' && !validDateTime(value)) errors.push(dataError(instancePath, `${schemaPath}/format`, 'format', 'not an RFC 3339 date-time'));
    if (schema.format === 'uri' && !validUri(value)) errors.push(dataError(instancePath, `${schemaPath}/format`, 'format', 'not an absolute URI'));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(dataError(instancePath, `${schemaPath}/minimum`, 'minimum', 'number is below minimum'));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(dataError(instancePath, `${schemaPath}/maximum`, 'maximum', 'number is above maximum'));
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(dataError(instancePath, `${schemaPath}/exclusiveMinimum`, 'exclusiveMinimum', 'number is not above exclusive minimum'));
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(dataError(instancePath, `${schemaPath}/exclusiveMaximum`, 'exclusiveMaximum', 'number is not below exclusive maximum'));
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) {
        errors.push(dataError(instancePath, `${schemaPath}/multipleOf`, 'multipleOf', 'number is not a multiple'));
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(dataError(instancePath, `${schemaPath}/minItems`, 'minItems', 'array has too few items'));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(dataError(instancePath, `${schemaPath}/maxItems`, 'maxItems', 'array has too many items'));
    if (schema.uniqueItems) {
      const keys = value.map(canonical);
      if (new Set(keys).size !== keys.length) errors.push(dataError(instancePath, `${schemaPath}/uniqueItems`, 'uniqueItems', 'array contains duplicates'));
    }
    const prefixLength = schema.prefixItems?.length ?? 0;
    schema.prefixItems?.forEach((candidate, index) => {
      if (index < value.length) errors.push(...check(candidate, value[index], `${instancePath}[${index}]`, `${schemaPath}/prefixItems/${index}`));
    });
    if (own(schema, 'items')) {
      for (let index = prefixLength; index < value.length; index += 1) {
        errors.push(...check(schema.items, value[index], `${instancePath}[${index}]`, `${schemaPath}/items`));
      }
    }
    if (schema.contains) {
      const count = value.filter(item => valid(schema.contains, item)).length;
      const minimum = schema.minContains ?? 1;
      if (count < minimum || (schema.maxContains !== undefined && count > schema.maxContains)) {
        errors.push(dataError(instancePath, `${schemaPath}/contains`, 'contains', 'matching item count is outside bounds'));
      }
    }
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(dataError(instancePath, `${schemaPath}/minProperties`, 'minProperties', 'object has too few properties'));
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(dataError(instancePath, `${schemaPath}/maxProperties`, 'maxProperties', 'object has too many properties'));
    if (schema.propertyNames) {
      keys.forEach(key => errors.push(...check(schema.propertyNames, key, `${instancePath}.{property:${key}}`, `${schemaPath}/propertyNames`)));
    }
    for (const key of schema.required ?? []) if (!own(value, key)) errors.push(dataError(instancePath, `${schemaPath}/required`, 'required', `missing required property '${key}'`));
    for (const [key, required] of Object.entries(schema.dependentRequired ?? {})) {
      if (own(value, key)) for (const dependency of required) if (!own(value, dependency)) {
        errors.push(dataError(instancePath, `${schemaPath}/dependentRequired/${key}`, 'dependentRequired', `'${key}' requires '${dependency}'`));
      }
    }
    const properties = schema.properties ?? {};
    const patternProperties = schema.patternProperties ?? {};
    for (const [key, child] of Object.entries(value)) {
      let matched = false;
      if (own(properties, key)) {
        matched = true;
        errors.push(...check(properties[key], child, `${instancePath}.${key}`, `${schemaPath}/properties/${key}`));
      }
      for (const [pattern, candidate] of Object.entries(patternProperties)) {
        if (new RegExp(pattern, 'u').test(key)) {
          matched = true;
          errors.push(...check(candidate, child, `${instancePath}.${key}`, `${schemaPath}/patternProperties/${pattern}`));
        }
      }
      if (!matched && own(schema, 'additionalProperties')) {
        if (schema.additionalProperties === false) errors.push(dataError(`${instancePath}.${key}`, `${schemaPath}/additionalProperties`, 'additionalProperties', `unexpected property '${key}'`));
        else if (schema.additionalProperties !== true) errors.push(...check(schema.additionalProperties, child, `${instancePath}.${key}`, `${schemaPath}/additionalProperties`));
      }
    }
  }
  return errors;
}

export function validateJsonSchema(schema, value) {
  const schemaErrors = auditSchema(schema);
  if (schemaErrors.length > 0) return { valid: false, errors: schemaErrors, schema_errors: schemaErrors.length };
  const errors = validateInstance(schema, schema, value, '$', '#');
  return { valid: errors.length === 0, errors, schema_errors: 0 };
}

export function formatJsonSchemaErrors(result, label = 'JSON document') {
  return result.errors.map(error => (
    `${label} ${error.instance_path}: ${error.message} [${error.keyword} at ${error.schema_path}]`
  ));
}

export function loadJsonSchema(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
