import { and, eq, ne } from 'drizzle-orm';
import { ValidationFailed } from './http/api.exception';
import { Role } from './roles';
import type { Db } from '../db/db';
import { schools, users } from '../db/schema';

type Reader = Pick<Db, '$count' | 'query'>;
type SeatRole = Role.Teacher | Role.Student;

/**
 * School seat caps (max_teachers / max_students, set by the platform admin).
 *
 * security: not in legacy — legacy counted every account of the role. An
 * `on_hold` account (a teacher/parent sign-up awaiting approval, or a student a
 * teacher put on hold) holds no seat, so sign-ups can't fill a school's seats;
 * moving an account off `on_hold` takes a seat and is checked like a new one.
 */
export function seatsUsed(db: Reader, schoolId: bigint, role: SeatRole) {
  return db.$count(
    users,
    and(
      eq(users.school_id, schoolId),
      eq(users.role, role),
      ne(users.status, 'on_hold'),
    ),
  );
}

export function isSeatRole(role: string): role is SeatRole {
  return role === (Role.Teacher as string) || role === (Role.Student as string);
}

/** 422 on `field` when the school has no free seat for the role. */
export async function assertSeatFree(
  db: Reader,
  schoolId: bigint | null,
  role: string,
  field: string,
  whoToAsk: 'platform admin' | 'school admin' = 'platform admin',
) {
  if (!schoolId || !isSeatRole(role)) return;
  const school = await db.query.schools.findFirst({
    where: eq(schools.id, schoolId),
    columns: { max_teachers: true, max_students: true, is_direct: true },
  });
  // not in legacy: Bodhira Direct (the default school) has no seat caps.
  if (!school || school.is_direct) return;
  const teacher = role === Role.Teacher;
  const max = Number(teacher ? school.max_teachers : school.max_students);
  if ((await seatsUsed(db, schoolId, role)) >= max) {
    throw ValidationFailed.field(
      field,
      `${teacher ? 'Teacher' : 'Student'} limit reached (${max}). Contact the ${whoToAsk} to raise it.`,
    );
  }
}
