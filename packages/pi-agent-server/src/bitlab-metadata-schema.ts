const BITLAB_DISPLAY_NAME_KEY = '_displayName';
const BITLAB_INTENT_KEY = '_intent';

const BITLAB_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'Bitlab UI metadata: human-friendly action name for display only.',
};

const BITLAB_INTENT_SCHEMA = {
  type: 'string',
  description: 'Bitlab UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * Return a Pi tool schema that accepts Bitlab's root-level metadata fields.
 *
 * Pi validates tool arguments before Bitlab's pre-tool-use hook can strip
 * `_displayName` / `_intent`. Built-in Pi tools often use strict schemas with
 * `additionalProperties: false`, so we add those fields as optional root
 * properties at the adapter boundary. Unknown schema shapes are returned
 * unchanged, and upstream-defined metadata properties win if Pi adds them later.
 */
export function allowBitlabMetadataProperties<T>(schema: T): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(BITLAB_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[BITLAB_DISPLAY_NAME_KEY] = BITLAB_DISPLAY_NAME_SCHEMA;
  }
  if (!(BITLAB_INTENT_KEY in nextProperties)) {
    nextProperties[BITLAB_INTENT_KEY] = BITLAB_INTENT_SCHEMA;
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** Strip Bitlab-only metadata before invoking the upstream Pi tool implementation. */
export function stripBitlabMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(BITLAB_DISPLAY_NAME_KEY in input) && !(BITLAB_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[BITLAB_DISPLAY_NAME_KEY];
  delete cleanInput[BITLAB_INTENT_KEY];

  return cleanInput as T;
}
