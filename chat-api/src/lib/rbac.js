// Role-based access control. Routes ask for a PERMISSION, never a role, so
// adding a role is a one-line change here.

export const ROLES = Object.freeze({
  ADMIN: "admin",        // full operator (same rights as the predefined admin)
  READONLY: "readonly",  // sees the console, changes nothing
  CUSTOMER: "customer",  // registered with an access key; chats with the operator
});

/** Roles that use the operator console (and must have a second factor). */
export const STAFF_ROLES = Object.freeze([ROLES.ADMIN, ROLES.READONLY]);
export const isStaff = (role) => STAFF_ROLES.includes(role);

export const PERMISSIONS = Object.freeze({
  KEYS_READ: "keys:read",              // list access keys
  KEYS_MANAGE: "keys:manage",          // mint / revoke access keys
  USERS_READ: "users:read",            // list accounts
  USERS_MANAGE: "users:manage",        // create / disable / delete accounts, change roles
  CHATS_READ: "chats:read",            // read every conversation
  CHATS_ALL: "chats:all",              // reply to every conversation (and mark it read)
  BIOPSIES_READ: "biopsies:read",      // see countdowns + archive status
  BIOPSIES_MANAGE: "biopsies:manage",  // set / reset deadlines, upload archives
  CHAT_OWN: "chat:own",                // read + write your own conversation
});

const P = PERMISSIONS;
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set([
    P.KEYS_READ, P.KEYS_MANAGE,
    P.USERS_READ, P.USERS_MANAGE,
    P.CHATS_READ, P.CHATS_ALL,
    P.BIOPSIES_READ, P.BIOPSIES_MANAGE,
  ]),
  [ROLES.READONLY]: new Set([P.KEYS_READ, P.USERS_READ, P.CHATS_READ, P.BIOPSIES_READ]),
  [ROLES.CUSTOMER]: new Set([P.CHAT_OWN]),
});

export function can(user, permission) {
  if (!user || user.active === false) return false;
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

export function permissionsFor(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
