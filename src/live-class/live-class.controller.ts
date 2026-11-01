import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { asc, eq, inArray, or } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { iso8601, routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import { countOf } from '../db/helpers';
import { class_student, class_subject, classes, syllabi } from '../db/schema';
import type { live_classes, users } from '../db/types';
import { SubscribedGuard } from '../student/subscribed.guard';
import { LiveClassService, liveStatus } from './live-class.service';
import { validateSchedule } from './live-class.validation';

const classLabel = (c: { grade: string; section: string }) =>
  `Grade ${c.grade} - ${c.section}`;

type HostView = Awaited<ReturnType<LiveClassService['hostView']>>;

const NOT_AUDIENCE = 'You are not in the audience for this live class.';

/** /api/v1/student/live-classes — port of Api\V1\Student\LiveClassApiController. */
@Controller('student/live-classes')
@Roles(Role.Student)
@UseGuards(SubscribedGuard) // security: not in legacy API
export class StudentLiveClassController {
  constructor(private readonly live: LiveClassService) {}

  private serialise(
    lc: live_classes & {
      users?: { name: string };
      subjects?: { name: string } | null;
    },
    detail = false,
  ) {
    const status = liveStatus(lc);
    return {
      id: lc.id,
      title: lc.title,
      scheduled_at: iso8601(lc.scheduled_at),
      duration_min: lc.duration_min,
      host_name: lc.users?.name ?? null,
      live_status: status,
      subject_id: lc.subject_id,
      ...(detail && {
        description: lc.description,
        provider: lc.provider,
        meeting_url:
          status === 'live' || status === 'scheduled' ? lc.meeting_url : null,
        subject: lc.subjects?.name ?? null,
      }),
    };
  }

  @Get()
  async index(@CurrentUser() user: users) {
    const all = await this.live.listForStudent(user);
    const by = (s: string) => all.filter((c) => liveStatus(c) === s);
    return ok({
      live_now: by('live').map((c) => this.serialise(c)),
      upcoming: by('scheduled').map((c) => this.serialise(c)),
      past: by('ended')
        .slice(0, 20)
        .map((c) => this.serialise(c)),
    });
  }

  @Get(':live')
  async show(@CurrentUser() user: users, @Param('live') raw: string) {
    const lc = await this.live.find(routeId(raw, 'LiveClass'));
    if (!(await this.live.canAccess(user, lc)))
      throw new ApiException(NOT_AUDIENCE, 403);
    const full = await this.live.withRelations(lc.id);
    return ok(this.serialise(full, true));
  }

  @Post(':live/join')
  @HttpCode(200)
  async join(@CurrentUser() user: users, @Param('live') raw: string) {
    const lc = await this.live.find(routeId(raw, 'LiveClass'));
    if (!(await this.live.canAccess(user, lc)))
      throw new ApiException(NOT_AUDIENCE, 403);
    const status = liveStatus(lc);
    if (status === 'cancelled')
      throw new ApiException('This class was cancelled.', 410);
    if (!lc.meeting_url)
      throw new ApiException('No meeting URL configured for this class.', 422);
    await this.live.recordJoin(lc, user);
    return ok(
      {
        meeting_url: lc.meeting_url,
        provider: lc.provider,
        live_status: status,
      },
      'Recorded join.',
    );
  }
}

/** /api/v1/teacher/live-classes — port of Api\V1\Teacher\LiveClassApiController. */
@Controller('teacher/live-classes')
@Roles(Role.Teacher)
export class TeacherLiveClassController {
  constructor(
    private readonly live: LiveClassService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * `class`, `subject`, `host_name`, `audience` and `attendees_count` are new
   * (not in the legacy API): legacy's web index and show pages displayed them.
   */
  private serialise(lc: HostView) {
    const audience = lc.classes
      ? { type: 'class', label: classLabel(lc.classes) }
      : lc.syllabi
        ? {
            type: 'syllabus',
            label: `${lc.syllabi.board} · Grade ${lc.syllabi.grade}`,
          }
        : { type: 'school', label: 'School-wide' };
    return {
      id: lc.id,
      title: lc.title,
      description: lc.description,
      scheduled_at: iso8601(lc.scheduled_at),
      duration_min: lc.duration_min,
      provider: lc.provider,
      meeting_url: lc.meeting_url,
      status: lc.status,
      live_status: liveStatus(lc),
      class_id: lc.class_id,
      syllabus_id: lc.syllabus_id,
      subject_id: lc.subject_id,
      class: lc.classes ? classLabel(lc.classes) : null,
      subject: lc.subjects?.name ?? null,
      host_name: lc.users?.name ?? null,
      audience,
      attendees_count: Number(lc.attendees_count ?? 0),
    };
  }

  private async hosted(user: users, raw: string) {
    const lc = await this.live.find(routeId(raw, 'LiveClass'));
    if (lc.host_id !== user.id) throw new ApiException('Forbidden.', 403);
    return lc;
  }

  @Get()
  async index(@CurrentUser() user: users) {
    return ok(
      (await this.live.listForHost(user)).map((lc) => this.serialise(lc)),
    );
  }

  /**
   * New (not in the legacy API): what the schedule form can target, from
   * LiveClassService::teacherScopes(). The legacy version called a missing
   * `Syllabus::active()` scope and threw; this returns the active syllabi it intended.
   */
  @Get('scopes')
  async scopes(@CurrentUser() user: users) {
    const assigned = await this.db.query.class_subject.findMany({
      where: eq(class_subject.teacher_id, user.id),
      columns: { class_id: true },
      orderBy: [asc(class_subject.id)],
    });
    const classRows = await this.db.query.classes.findMany({
      where: or(
        eq(classes.class_teacher_id, user.id),
        inArray(
          classes.id,
          assigned.map((a) => a.class_id),
        ),
      ),
      orderBy: [asc(classes.grade), asc(classes.section), asc(classes.id)],
      extras: (t) => ({
        students_count: countOf(class_student, 'class_id', t.id).as(
          'students_count',
        ),
      }),
    });
    const allSyllabi = await this.db.query.syllabi.findMany({
      where: eq(syllabi.is_active, true),
      orderBy: [
        asc(syllabi.sort_order),
        asc(syllabi.board),
        asc(syllabi.grade),
        asc(syllabi.id),
      ],
    });
    // security: not in legacy — only syllabi the teacher's school uses.
    const used = user.school_id
      ? await this.live.syllabiUsedBy(user.school_id)
      : new Set<bigint>();
    const syllabusRows = allSyllabi.filter((s) => used.has(s.id));
    // Not in legacy: the subjects taught in those classes, for the optional `subject_id`.
    const subjectRows = classRows.length
      ? await this.db.query.class_subject.findMany({
          where: inArray(
            class_subject.class_id,
            classRows.map((c) => c.id),
          ),
          orderBy: [asc(class_subject.subject_id), asc(class_subject.id)],
          with: { subjects: { columns: { id: true, name: true } } },
        })
      : [];
    return ok({
      classes: classRows.map((c) => ({
        id: c.id,
        label: `Grade ${c.grade} - ${c.section}`,
        students_count: c.students_count,
      })),
      subjects: subjectRows.map((r) => ({
        id: r.subjects.id,
        name: r.subjects.name,
        class_id: r.class_id,
      })),
      syllabi: syllabusRows.map((s) => ({
        id: s.id,
        name: s.name,
        board: s.board,
        grade: s.grade,
      })),
    });
  }

  @Post()
  async store(@CurrentUser() user: users, @Body() body: unknown) {
    const data = await validateSchedule(
      this.db,
      (body ?? {}) as Record<string, unknown>,
    );
    const lc = await this.live.schedule(user, data);
    return ok(
      this.serialise(await this.live.hostView(lc.id)),
      'Live class scheduled.',
    );
  }

  @Get(':live')
  async show(@CurrentUser() user: users, @Param('live') raw: string) {
    const lc = await this.hosted(user, raw);
    const attendees = await this.live.attendees(lc);
    return ok({
      ...this.serialise(await this.live.hostView(lc.id)),
      attendees: attendees.map((a) => ({
        user_id: a.user_id,
        name: a.users?.name ?? null,
        joined_at: iso8601(a.joined_at),
        left_at: iso8601(a.left_at),
      })),
    });
  }

  @Post(':live/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: users, @Param('live') raw: string) {
    const lc = await this.hosted(user, raw);
    return ok(
      this.serialise(await this.live.hostView((await this.live.cancel(lc)).id)),
      'Live class cancelled.',
    );
  }
}
