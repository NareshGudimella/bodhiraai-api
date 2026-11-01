import type { schools, users } from '../db/types';
import { roleLabel } from '../common/roles';

/** Mirrors App\Http\Resources\UserResource. */
export function userResource(user: users & { schools?: schools | null }) {
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    role_label: roleLabel(user.role),
    avatar: user.avatar,
    grade: user.grade,
    gender: user.gender,
    dob: user.dob ? user.dob.toISOString().slice(0, 10) : null,
    status: user.status,
    // Additive (not in legacy's UserResource): the web app's language.
    locale: user.locale,
    ...(user.schools !== undefined && {
      school: user.schools
        ? {
            id: Number(user.schools.id),
            name: user.schools.name,
            code: user.schools.code,
            logo: user.schools.logo,
          }
        : null,
    }),
    email_verified: Boolean(user.email_verified_at),
    phone_verified: Boolean(user.phone_verified_at),
    created_at: user.created_at
      ? user.created_at.toISOString().replace(/\.\d{3}Z$/, '+00:00')
      : null,
  };
}

export type UserResource = ReturnType<typeof userResource>;
