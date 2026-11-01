import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { and, eq, exists, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { RateLimit } from '../common/decorators/rate-limit';
import { ApiException } from '../common/http/api.exception';
import { ok } from '../common/http/api-response';
import { iso8601, modelNotFound, routeId } from '../common/http/laravel';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role, roleLabel } from '../common/roles';
import { DB, type Db } from '../db/db';
import { asc, countOf, desc, myDesc } from '../db/helpers';
import {
  class_student,
  classes as classesTable,
  conversations as conversationsTable,
  messages as messagesTable,
  parent_student,
  users as usersTable,
} from '../db/schema';
import type { conversations, messages, users } from '../db/types';
import { signedFileUrl } from '../storage/file-url';

const NOT_PARTICIPANT = 'You are not part of this conversation.';

/** PHP date('g:i A') in UTC. */
function clock(d: Date | null) {
  if (!d) return null;
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function partner(u: users | null) {
  return u
    ? {
        id: u.id,
        name: u.name,
        role: u.role,
        role_label: roleLabel(u.role),
        avatar: signedFileUrl(u.avatar), // security: not in legacy: signed private-file link
      }
    : null;
}

const messageItem = (m: messages, me: bigint) => ({
  id: m.id,
  body: m.body,
  mine: m.sender_id === me,
  read: m.read_at !== null,
  created_at: iso8601(m.created_at),
  time: clock(m.created_at),
});

/**
 * /api/v1/chat/* — port of Api\V1\Chat\ChatApiController (parent ↔ teacher).
 * Conversation rows are shared with the legacy web chat.
 */
@Controller('chat')
@Roles(Role.Teacher, Role.Parent)
export class ChatController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async conversation(me: users, raw: string) {
    const c = await this.db.query.conversations.findFirst({
      where: eq(conversationsTable.id, routeId(raw, 'Conversation')),
    });
    if (!c) throw modelNotFound('Conversation', raw);
    if (c.user_one_id !== me.id && c.user_two_id !== me.id)
      throw new ApiException(NOT_PARTICIPANT, 403);
    return c;
  }

  private async findStudent(raw: string) {
    const s = await this.db.query.users.findFirst({
      where: eq(usersTable.id, routeId(raw, 'User')),
    });
    if (!s) throw modelNotFound('User', raw);
    return s;
  }

  /** Conversation::between(): firstOrCreate on the ordered pair. */
  private async between(a: bigint, b: bigint) {
    const [one, two] = a < b ? [a, b] : [b, a];
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversationsTable.user_one_id, one),
        eq(conversationsTable.user_two_id, two),
      ),
    });
    if (existing) return existing;
    const now = new Date();
    const [created] = await this.db
      .insert(conversationsTable)
      .values({
        user_one_id: one,
        user_two_id: two,
        created_at: now,
        updated_at: now,
      })
      .returning();
    return created;
  }

  /** First enrolled class (relation order) that has a class teacher. */
  private async classTeacherOf(student: users) {
    const classes = await this.db.query.class_student.findMany({
      where: eq(class_student.student_id, student.id),
      orderBy: [asc(class_student.class_id), asc(class_student.id)],
      with: { classes: { with: { users: true } } },
    });
    return classes.map((c) => c.classes.users).find((t) => !!t) ?? null;
  }

  private async firstParentOf(student: users) {
    const link = await this.db.query.parent_student.findFirst({
      where: eq(parent_student.student_id, student.id),
      orderBy: [asc(parent_student.parent_id), asc(parent_student.id)],
      with: { users_parent_student_parent_idTousers: true },
    });
    return link?.users_parent_student_parent_idTousers ?? null;
  }

  @Get()
  async index(@CurrentUser() me: users) {
    const list = await this.db.query.conversations.findMany({
      where: or(
        eq(conversationsTable.user_one_id, me.id),
        eq(conversationsTable.user_two_id, me.id),
      ),
      orderBy: [
        myDesc(conversationsTable.last_message_at),
        desc(conversationsTable.id),
      ],
      with: {
        users_conversations_user_one_idTousers: true,
        users_conversations_user_two_idTousers: true,
      },
      extras: (t) => ({
        unread_count: countOf(
          messagesTable,
          'conversation_id',
          t.id,
          (c) => sql`${c('sender_id')} <> ${me.id} and ${c('read_at')} is null`,
        ).as('unread_count'),
      }),
    });
    const latest = await this.db.query.messages.findMany({
      where: inArray(
        messagesTable.conversation_id,
        list.map((c) => c.id),
      ),
      orderBy: [desc(messagesTable.id)],
    });
    const preview = new Map<bigint, messages>();
    for (const m of latest)
      if (!preview.has(m.conversation_id)) preview.set(m.conversation_id, m);

    return ok(
      list.map((c) => {
        const p = preview.get(c.id);
        return {
          id: c.id,
          partner: partner(
            c.user_one_id === me.id
              ? c.users_conversations_user_two_idTousers
              : c.users_conversations_user_one_idTousers,
          ),
          last_message_at: iso8601(c.last_message_at),
          unread_count: c.unread_count,
          preview: p
            ? {
                body: p.body,
                mine: p.sender_id === me.id,
                time: clock(p.created_at),
              }
            : null,
        };
      }),
    );
  }

  @Get('contacts')
  async contacts(@CurrentUser() me: users) {
    const out: object[] = [];
    if (me.role === (Role.Parent as string)) {
      const children = await this.db.query.parent_student.findMany({
        where: eq(parent_student.parent_id, me.id),
        orderBy: [asc(parent_student.student_id), asc(parent_student.id)],
        with: { users_parent_student_student_idTousers: true },
      });
      for (const link of children) {
        const child = link.users_parent_student_student_idTousers;
        const teacher = await this.classTeacherOf(child);
        if (teacher) {
          out.push({
            start: 'with-teacher',
            student: { id: child.id, name: child.name },
            partner: partner(teacher),
          });
        }
      }
    } else if (me.role === (Role.Teacher as string)) {
      const seen = new Set<bigint>();
      const classes = await this.db.query.classes.findMany({
        where: eq(classesTable.class_teacher_id, me.id),
        orderBy: [asc(classesTable.id)],
        with: {
          class_student: {
            orderBy: (t) => [asc(t.student_id), asc(t.id)],
            with: { users: true },
          },
        },
      });
      for (const c of classes) {
        for (const enrolment of c.class_student) {
          const parent = await this.firstParentOf(enrolment.users);
          if (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            out.push({
              start: 'with-parent',
              student: { id: enrolment.users.id, name: enrolment.users.name },
              partner: partner(parent),
            });
          }
        }
      }
    }
    return ok(out);
  }

  @Post('with-teacher/:student')
  @HttpCode(200)
  async withTeacher(@CurrentUser() me: users, @Param('student') raw: string) {
    const student = await this.findStudent(raw);
    const linked =
      me.role === (Role.Parent as string) &&
      !!(await this.db.query.parent_student.findFirst({
        where: and(
          eq(parent_student.parent_id, me.id),
          eq(parent_student.student_id, student.id),
        ),
        orderBy: [asc(parent_student.id)],
      }));
    if (!linked)
      throw new ApiException(
        'You are not allowed to message this teacher.',
        403,
      );
    const teacher = await this.classTeacherOf(student);
    if (!teacher)
      throw new ApiException(
        `No class teacher is assigned to ${student.name} yet.`,
        404,
      );
    const c = await this.between(me.id, teacher.id);
    return ok({ id: c.id, partner: partner(teacher) });
  }

  @Post('with-parent/:student')
  @HttpCode(200)
  async withParent(@CurrentUser() me: users, @Param('student') raw: string) {
    const student = await this.findStudent(raw);
    const teaches =
      me.role === (Role.Teacher as string) &&
      !!(await this.db.query.class_student.findFirst({
        where: (t) =>
          and(
            eq(t.student_id, student.id),
            exists(
              this.db
                .select({ x: sql`1` })
                .from(classesTable)
                .where(
                  and(
                    eq(classesTable.id, t.class_id),
                    eq(classesTable.class_teacher_id, me.id),
                  ),
                ),
            ),
          ),
        orderBy: [asc(class_student.id)],
      }));
    if (!teaches)
      throw new ApiException(
        'You are not allowed to message this parent.',
        403,
      );
    const parent = await this.firstParentOf(student);
    if (!parent)
      throw new ApiException(
        `No parent is linked to ${student.name} yet.`,
        404,
      );
    const c = await this.between(me.id, parent.id);
    return ok({ id: c.id, partner: partner(parent) });
  }

  @Get(':conversation')
  async show(@CurrentUser() me: users, @Param('conversation') raw: string) {
    const c: conversations = await this.conversation(me, raw);
    const now = new Date();
    // Eloquent builder update() also bumps updated_at.
    await this.db
      .update(messagesTable)
      .set({ read_at: now, updated_at: now })
      .where(
        and(
          eq(messagesTable.conversation_id, c.id),
          ne(messagesTable.sender_id, me.id),
          isNull(messagesTable.read_at),
        ),
      );
    const msgs = await this.db.query.messages.findMany({
      where: eq(messagesTable.conversation_id, c.id),
      orderBy: [asc(messagesTable.id)],
    });
    const other =
      (await this.db.query.users.findFirst({
        where: eq(
          usersTable.id,
          c.user_one_id === me.id ? c.user_two_id : c.user_one_id,
        ),
      })) ?? null;
    return ok({
      conversation: { id: c.id, partner: partner(other) },
      messages: msgs.map((m) => messageItem(m, me.id)),
    });
  }

  @Post(':conversation/messages')
  @RateLimit(60, 'user')
  async send(
    @CurrentUser() me: users,
    @Param('conversation') raw: string,
    @Body() body: unknown,
  ) {
    const c = await this.conversation(me, raw);
    const data = await laravelValidate(this.db, body, {
      body: ['required', 'string', 'max:5000'],
    });
    const now = new Date();
    const [m] = await this.db
      .insert(messagesTable)
      .values({
        conversation_id: c.id,
        sender_id: me.id,
        body: data.body as string,
        created_at: now,
        updated_at: now,
      })
      .returning();
    await this.db
      .update(conversationsTable)
      .set({ last_message_at: now, updated_at: now })
      .where(eq(conversationsTable.id, c.id));
    return ok(messageItem(m, me.id), 'Message sent.');
  }
}
