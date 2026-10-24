// Shared by the Host and the browser bundle; no Host or schema-library imports.
export const packageName = '@local/dsh-browser-flock';

/** Validate without coercion, cloning, or executing property getters. */
export function parseJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Expected lossless JSON');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Expected a plain JSON object or array');
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new TypeError('Invalid JSON array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !property.enumerable || !('value' in property)) {
        throw new TypeError('Invalid JSON property');
      }
      parseJson(property.value, ancestors);
    }
    if (array) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Sparse JSON array');
      }
    }
    return value;
  } finally {
    ancestors.delete(value);
  }
}

export const jsonCodec = {
  mode: 'strict',
  typeSymbol: `${packageName}#JsonValue`,
  create: () => ({ parse: parseJson }),
};

// Business input: { action: toolName, args: {...} }; business validation is
// owned by dispatch. Its result is the Flock { ok, data?, error? } envelope.
export const dispatchDescriptor = {
  id: `${packageName}#browserFlock/dispatch`,
  service: 'browserFlock',
  namespace: 'browserFlock',
  method: 'dispatch',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec: jsonCodec }],
  result: jsonCodec,
};

export const contribution = {
  package: packageName,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [dispatchDescriptor],
};

export const remoteContribution = {
  package: packageName,
  descriptors: [dispatchDescriptor],
};

// Gateway parses inputs but does not parse plain JSON outputs automatically.
// Host dispatch must parseJson its final envelope before returning it.
// Client returns RemoteResult<FlockEnvelope>: check outer result.ok first,
// then result.value.ok; a business failure is still an outer RPC success.
