/**
 * Module permissions constants and helpers.
 *
 * 4 permissions control access to routes and dashboard visibility:
 *   - empresas
 *   - pessoas
 *   - politicos (includes mandatos + emendas)
 *   - noticias
 */

export const PERMISSIONS = {
  EMPRESAS: 'empresas',
  PESSOAS: 'pessoas',
  POLITICOS: 'politicos',
  NOTICIAS: 'noticias',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Maps dashboard module keys to the permission that controls them.
 * "mandatos" and "emendas" are sub-modules of "politicos".
 */
export const MODULE_PERMISSIONS: Record<string, Permission> = {
  empresas: PERMISSIONS.EMPRESAS,
  pessoas: PERMISSIONS.PESSOAS,
  politicos: PERMISSIONS.POLITICOS,
  mandatos: PERMISSIONS.POLITICOS,
  emendas: PERMISSIONS.POLITICOS,
  noticias: PERMISSIONS.NOTICIAS,
};

/**
 * Checks whether a user has access to a given module.
 */
export function hasModuleAccess(
  userPermissions: string[] | undefined | null,
  module: string,
): boolean {
  if (!userPermissions) return false;
  const required = MODULE_PERMISSIONS[module];
  if (!required) return true; // unknown module = no restriction
  return userPermissions.includes(required);
}

/**
 * Permission metadata for UI (admin panel labels/descriptions).
 */
export const PERMISSION_INFO: Record<Permission, { label: string; description: string }> = {
  empresas: { label: 'Empresas', description: 'Busca, detalhes e aprovacao de empresas' },
  pessoas: { label: 'Pessoas', description: 'Busca, perfis e agente de pessoas' },
  politicos: { label: 'Politicos', description: 'Politicos, mandatos e emendas' },
  noticias: { label: 'Noticias', description: 'Busca e listagem de noticias' },
};
