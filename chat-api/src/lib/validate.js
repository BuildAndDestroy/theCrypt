// Strict, type-checked input validation. Every value from a request body is
// checked to be a plain string BEFORE it goes near a query, which (together
// with mongoose sanitizeFilter) shuts the door on operator injection like
// {"email": {"$ne": null}}.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

function str(body, field, { required = true, max = 200, min = 0 } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min) throw new ValidationError(`${field} must be at least ${min} characters`);
  if (t.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return t;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{7,25}$/;

export function email(body, field = "email") {
  const v = str(body, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(v)) throw new ValidationError("email is not valid");
  return v;
}

export function phone(body, field = "phone") {
  const v = str(body, field, { required: false, max: 25 });
  if (v !== undefined && !PHONE_RE.test(v)) throw new ValidationError("phone is not valid");
  return v;
}

export function password(body, field = "password") {
  // Not trimmed: spaces are legitimate password characters.
  const v = body?.[field];
  if (typeof v !== "string" || v.length === 0) throw new ValidationError(`${field} is required`);
  if (v.length > 200) throw new ValidationError(`${field} is too long`);
  return v;
}

export function newPassword(body, field = "password") {
  const v = password(body, field);
  if (v.length < 12) throw new ValidationError("password must be at least 12 characters");
  return v;
}

export function text(body, field, opts) {
  return str(body, field, opts);
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export function objectId(value, name = "id") {
  if (typeof value !== "string" || !OBJECT_ID_RE.test(value)) {
    throw new ValidationError(`${name} is not valid`);
  }
  return value;
}

export function optionalObjectId(value, name) {
  return value === undefined || value === "" ? undefined : objectId(value, name);
}
