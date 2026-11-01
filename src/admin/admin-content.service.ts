import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { directSchoolId } from '../common/direct-school';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc } from '../db/helpers';
import { schools, subjects as subjectsTable, syllabi } from '../db/schema';
import type { subjects, users } from '../db/types';
import { LiveClassService } from '../live-class/live-class.service';
import { signedFileUrl } from '../storage/file-url';
import { lessonPlayback } from '../video/lesson-playback';

/**
 * not in legacy (2026-11-01): what a school admin may watch. The Super Admin's
 * curricula the school uses (`LiveClassService.syllabiUsedBy`) and the
 * school's own subjects: `GET /admin/content`, and admin access in
 * `GET /lessons/:id/playback`. A super admin (no school) acts on Bodhira Direct.
 */
@Injectable()
export class AdminContentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly live: LiveClassService,
  ) {}

  /** The admin's school; Bodhira Direct for a super admin. */
  async schoolFor(admin: users) {
    if (admin.school_id !== null) return admin.school_id;
    return admin.role === (Role.SuperAdmin as string)
      ? directSchoolId(this.db)
      : null;
  }

  /** Active subjects the school may watch: platform subjects of a used syllabus, or its own. */
  private async scope(schoolId: bigint) {
    const used = [...(await this.live.syllabiUsedBy(schoolId))];
    return {
      used,
      where: and(
        eq(subjectsTable.is_active, true),
        or(
          eq(subjectsTable.school_id, schoolId),
          used.length
            ? and(
                isNull(subjectsTable.school_id),
                inArray(subjectsTable.syllabus_id, used),
              )
            : undefined,
        ),
      ),
    };
  }

  /** May the admin watch this subject's lessons? */
  async mayWatch(admin: users, subject: subjects) {
    const schoolId = await this.schoolFor(admin);
    if (!schoolId || !subject.is_active) return false;
    if (subject.school_id !== null) return subject.school_id === schoolId;
    return (
      subject.syllabus_id !== null &&
      (await this.live.syllabiUsedBy(schoolId)).has(subject.syllabus_id)
    );
  }

  /**
   * Published chapters and lessons, grouped by syllabus (ordered like the
   * sign-up list) and ordered like the student views. The school's own
   * subjects outside those syllabi come last, under `{id: null, name: <school>}`.
   */
  async content(admin: users) {
    const schoolId = await this.schoolFor(admin);
    if (!schoolId) return { syllabi: [] };
    const { used, where } = await this.scope(schoolId);
    const rows = await this.db.query.subjects.findMany({
      where,
      orderBy: [
        asc(subjectsTable.sort_order),
        asc(subjectsTable.name),
        asc(subjectsTable.id),
      ],
      columns: { id: true, name: true, grade: true, syllabus_id: true },
      with: {
        chapters: {
          where: (c) => eq(c.is_published, true),
          orderBy: (c) => [asc(c.sort_order), asc(c.id)],
          columns: { id: true, title: true },
          with: {
            lessons: {
              where: (l) => eq(l.is_published, true),
              orderBy: (l) => [asc(l.sort_order), asc(l.id)],
              columns: {
                id: true,
                title: true,
                type: true,
                duration_sec: true,
                thumbnail: true,
                content_url: true,
                video_id: true,
              },
            },
          },
        },
      },
    });
    const subject = (s: (typeof rows)[number]) => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      chapters: s.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        lessons: c.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          type: l.type,
          duration_sec: l.duration_sec,
          playback: lessonPlayback(l),
          thumbnail: signedFileUrl(l.thumbnail),
        })),
      })),
    });

    const syllabusRows = used.length
      ? await this.db.query.syllabi.findMany({
          where: inArray(syllabi.id, used),
          orderBy: [
            asc(syllabi.sort_order),
            asc(syllabi.board),
            asc(syllabi.grade),
            asc(syllabi.id),
          ],
          columns: { id: true, name: true },
        })
      : [];
    const out: {
      id: bigint | null;
      name: string;
      subjects: ReturnType<typeof subject>[];
    }[] = syllabusRows.map((y) => ({
      id: y.id,
      name: y.name,
      subjects: rows.filter((s) => s.syllabus_id === y.id).map(subject),
    }));
    const placed = new Set(syllabusRows.map((y) => y.id));
    const own = rows.filter(
      (s) => s.syllabus_id === null || !placed.has(s.syllabus_id),
    );
    if (own.length) {
      const school = await this.db.query.schools.findFirst({
        where: eq(schools.id, schoolId),
        columns: { name: true },
      });
      out.push({
        id: null,
        name: school?.name ?? '',
        subjects: own.map(subject),
      });
    }
    return { syllabi: out };
  }
}
