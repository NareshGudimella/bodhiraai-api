import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { AuthedRequest } from '../common/decorators/auth.decorators';
import { forbidden, modelNotFound, routeId } from '../common/http/laravel';
import { DB, type Db } from '../db/db';
import { assignments, class_student } from '../db/schema';

/**
 * security: not in legacy. The cheap part of the submit checks (the assignment exists, is
 * published and is in one of the student's classes) as a guard, so a refused upload is
 * answered before the multipart body is buffered (guards run before interceptors).
 * Same 404 / 403 as the controller's own check.
 */
@Injectable()
export class AssignmentVisibleGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const raw = (req as Request).params?.assignment;
    if (!req.user || typeof raw !== 'string') return true;
    const id = routeId(raw, 'Assignment');
    const a = await this.db.query.assignments.findFirst({
      where: eq(assignments.id, id),
      columns: { class_id: true, is_published: true },
    });
    if (!a) throw modelNotFound('Assignment', id);
    if (!a.is_published) throw forbidden();
    const [member] = await this.db
      .select({ id: class_student.id })
      .from(class_student)
      .where(
        and(
          eq(class_student.student_id, req.user.id),
          eq(class_student.class_id, a.class_id),
        ),
      )
      .limit(1);
    if (!member) throw forbidden();
    return true;
  }
}
