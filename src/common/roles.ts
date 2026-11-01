/** Mirrors App\Enums\Role in the legacy Laravel app. */
export enum Role {
  Student = 'student',
  Teacher = 'teacher',
  Parent = 'parent',
  Admin = 'admin',
  SuperAdmin = 'super_admin',
  ContentManager = 'content_manager',
  WebAdmin = 'web_admin',
}

const LABELS: Record<Role, string> = {
  [Role.Student]: 'Student',
  [Role.Teacher]: 'Teacher',
  [Role.Parent]: 'Parent',
  [Role.Admin]: 'School Admin',
  [Role.SuperAdmin]: 'Super Admin',
  [Role.ContentManager]: 'Content Manager',
  [Role.WebAdmin]: 'Web Admin',
};

export function roleLabel(role: string): string | null {
  return LABELS[role as Role] ?? null;
}

/** Sanctum token abilities issued at login (AuthController::abilitiesFor). */
export function abilitiesFor(role: string): string[] {
  return role === (Role.SuperAdmin as string)
    ? [`role:${role}`, '*']
    : [`role:${role}`];
}
