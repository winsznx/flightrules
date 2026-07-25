export type { NormaliserConfig, NormaliserIdentity } from "./config.js";
export {
  DEFAULT_NORMALISER_CONFIG,
  hashNormaliserConfig,
  IDENTIFIER_PLACEHOLDER,
  identityOf,
} from "./config.js";
export type { Tokenised } from "./identifiers.js";
export {
  detokenise,
  isAllDigits,
  isLongHex,
  isUlid,
  isUuid,
  splitPrefixedIdentifier,
  tokenise,
} from "./identifiers.js";
export type {
  Classification,
  NormalisationStep,
  NormalisedAttributes,
  SafeAttributeValue,
  SafeScalar,
} from "./normalise.js";
export {
  classify,
  NORMALISATION_STEPS,
  normaliseAttributes,
  normaliseName,
  toSafeAttributeValue,
} from "./normalise.js";
