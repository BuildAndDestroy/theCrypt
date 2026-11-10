// Role-based access control. Routes ask for a PERMISSION, never a role, so
// adding a role (e.g. a junior "operator" who can chat but not mint keys) is a
// one-line change here.

export const ROLES = Object.freeze({
  ADMIN: "admin",
  CUSTOMER: "customer",
});

export const PERMISSIONS = Object.freeze({
  KEYS_MANAGE: "keys:manage",          // mint / list / revoke access keys
  USERS_MANAGE: "users:manage",        // list / disable customer accounts
  CHATS_ALL: "chats:all",              // read + reply to every conversation
  CHAT_OWN: "chat:own",                // read + write your own conversation
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set([
    PERMISSIONS.KEYS_MANAGE,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.CHATS_ALL,
  ]),
  [ROLES.CUSTOMER]: new Set([PERMISSIONS.CHAT_OWN]),
});

export function can(user, permission) {
  if (!user || user.active === false) return false;
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

export function permissionsFor(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
