process.env.TZ = 'UTC';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { loadEnv } from '../src/config/env';
import { DB, type Db } from '../src/db/db';
import {
  assignment_submissions,
  assignments,
  class_student,
  class_subject,
  classes,
  notifications,
  personal_access_tokens,
  questions,
  quiz_attempts,
  quizzes,
  schools,
  subjects,
  users,
} from '../src/db/schema';
import type { users as User } from '../src/db/types';
import { signFileKey } from '../src/storage/file-url';

loadEnv();

const tag = randomBytes(3).toString('hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * Teacher assignments, grading and quizzes: create (with attachment rules),
 * detail, grading with its ownership guard, quiz list and analytics, and the
 * AssignmentPublished / SubmissionGraded notification rows.
 *
 * Builds its own school (class teacher, a second teacher, three students, a
 * class, quizzes and attempts) and removes every row it made afterwards,
 * notifications included. Private uploads go to a temporary LOCAL_PRIVATE_DIR.
 */
describe('Teacher assignments, grading and quizzes (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let privateDir: string;
  const envBefore: Record<string, string | undefined> = {};
  const createdUsers: bigint[] = [];
  let schoolId: bigint;
  const t: Record<string, string> = {};
  const u: Record<string, User> = {};
  let classId: bigint;
  let subjectId: bigint;
  let otherAssignmentId: bigint;
  let otherSubmissionId: bigint;
  let ownQuizId: bigint;
  let otherQuizId: bigint;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in envBefore)) envBefore[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const notificationsFor = (type: string, ids: bigint[]) =>
    db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.type, `App\\Notifications\\${type}`),
          inArray(notifications.notifiable_id, ids),
        ),
      )
      .orderBy(asc(notifications.notifiable_id));

  const assignmentCount = () =>
    db.$count(assignments, eq(assignments.class_id, classId));

  beforeAll(async () => {
    privateDir = await mkdtemp(join(tmpdir(), 'bodhira-teacher-'));
    setEnv('STORAGE_DRIVER', 'local');
    setEnv('LOCAL_PRIVATE_DIR', privateDir);
    setEnv('FILES_BASE_URL', 'http://files.e2e.test');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>(),
    );
    await app.init();
    db = app.get<Db>(DB);
    const tokens = app.get(TokenService);
    const now = new Date();

    const [school] = await db
      .insert(schools)
      .values({
        name: `Teacher E2E ${tag}`,
        slug: `teacher-e2e-${tag}`,
        code: `TE${tag.toUpperCase()}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    schoolId = school.id;

    // Names chosen so the roster's name order differs from id order.
    for (const [who, role, name] of [
      ['teacher', 'teacher', 'Teacher One'],
      ['other', 'teacher', 'Teacher Two'],
      ['s1', 'student', 'Zoya'],
      ['s2', 'student', 'Arjun'],
      ['s3', 'student', 'Meera'],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: `${name} ${tag}`,
          email: `teach-${tag}-${who}@bodhira.test`,
          password: 'x',
          role,
          status: 'active',
          school_id: school.id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      createdUsers.push(user.id);
      u[who] = user;
      t[who] = await tokens.issue(user, 'e2e', [`role:${role}`]);
    }

    const [subject] = await db
      .insert(subjects)
      .values({
        school_id: school.id,
        name: `Science ${tag}`,
        slug: `science-${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    subjectId = subject.id;
    const [klass] = await db
      .insert(classes)
      .values({
        school_id: school.id,
        grade: '8',
        section: `T${tag}`,
        class_teacher_id: u.teacher.id,
        created_at: now,
        updated_at: now,
      })
      .returning();
    classId = klass.id;
    await db.insert(class_subject).values({
      class_id: klass.id,
      subject_id: subject.id,
      teacher_id: u.teacher.id,
    });
    // s1 and s2 are enrolled; s3 is in the school but not the class.
    await db.insert(class_student).values([
      { class_id: klass.id, student_id: u.s1.id, roll_no: '1' },
      { class_id: klass.id, student_id: u.s2.id, roll_no: '2' },
    ]);

    // The other teacher's assignment (same class) with a submission by s1.
    const [otherA] = await db
      .insert(assignments)
      .values({
        class_id: klass.id,
        teacher_id: u.other.id,
        title: `Other ${tag}`,
        max_marks: 20,
        is_published: true,
        created_at: now,
        updated_at: now,
      })
      .returning();
    otherAssignmentId = otherA.id;
    const [otherSub] = await db
      .insert(assignment_submissions)
      .values({
        assignment_id: otherA.id,
        student_id: u.s1.id,
        status: 'submitted',
        submitted_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning();
    otherSubmissionId = otherSub.id;

    const [q1] = await db
      .insert(quizzes)
      .values({
        school_id: school.id,
        subject_id: subject.id,
        created_by: u.teacher.id,
        title: `Quiz ${tag}`,
        duration_min: 20,
        total_marks: 10,
        pass_marks: 5,
        is_published: true,
        created_at: now,
        updated_at: now,
      })
      .returning();
    ownQuizId = q1.id;
    const [q2] = await db
      .insert(quizzes)
      .values({
        school_id: school.id,
        created_by: u.other.id,
        title: `Other quiz ${tag}`,
        created_at: now,
        updated_at: now,
      })
      .returning();
    otherQuizId = q2.id;
    await db.insert(questions).values(
      [1, 2, 3].map((i) => ({
        quiz_id: q1.id,
        body: `Q${i}`,
        marks: 1,
        sort_order: i,
        created_at: now,
        updated_at: now,
      })),
    );
    const at = (min: number) => new Date(now.getTime() - min * 60_000);
    await db.insert(quiz_attempts).values([
      // submitted: 8/10 (pass), 3/10 (fail), 5/10 (pass, exactly pass_marks)
      {
        quiz_id: q1.id,
        student_id: u.s1.id,
        status: 'submitted',
        score: 8,
        total_marks: 10,
        submitted_at: at(30),
      },
      {
        quiz_id: q1.id,
        student_id: u.s2.id,
        status: 'submitted',
        score: 3,
        total_marks: 10,
        submitted_at: at(10),
      },
      {
        quiz_id: q1.id,
        student_id: u.s2.id,
        status: 'submitted',
        score: 5,
        total_marks: 10,
        submitted_at: at(20),
      },
      // in progress: counted by attempts_count, not by analytics
      {
        quiz_id: q1.id,
        student_id: u.s1.id,
        status: 'in_progress',
        score: 0,
        total_marks: 10,
      },
    ]);
  });

  afterAll(async () => {
    if (db && createdUsers.length) {
      await db
        .delete(notifications)
        .where(inArray(notifications.notifiable_id, createdUsers));
      await db
        .delete(personal_access_tokens)
        .where(inArray(personal_access_tokens.tokenable_id, createdUsers));
      if (schoolId) {
        // questions, attempts cascade from the quiz; assignments and
        // submissions from the class / users; class_subject from the class.
        await db.delete(quizzes).where(eq(quizzes.school_id, schoolId));
        await db.delete(classes).where(eq(classes.school_id, schoolId));
        await db.delete(subjects).where(eq(subjects.school_id, schoolId));
      }
      await db.delete(users).where(inArray(users.id, createdUsers));
      if (schoolId) await db.delete(schools).where(eq(schools.id, schoolId));
    }
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app?.close();
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
  });

  // ── Create ──

  it('validates a new assignment in rule order before any write', async () => {
    const before = await assignmentCount();
    const empty = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .send({})
      .expect(422);
    expect(empty.body.errors).toEqual({
      class_id: ['The class id field is required.'],
      title: ['The title field is required.'],
      max_marks: ['The max marks field is required.'],
    });
    const bad = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .send({
        class_id: 99999999,
        subject_id: 99999999,
        title: 'x'.repeat(161),
        attachment_url: 'not a url',
        due_date: 'someday',
        max_marks: 1001,
      })
      .expect(422);
    expect(bad.body.errors).toEqual({
      class_id: ['The selected class id is invalid.'],
      subject_id: ['The selected subject id is invalid.'],
      title: ['The title field must not be greater than 160 characters.'],
      attachment_url: ['The attachment url field must be a valid URL.'],
      due_date: ['The due date field must be a valid date.'],
      max_marks: ['The max marks field must not be greater than 1000.'],
    });
    const zero = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .send({ class_id: Number(classId), title: 'T', max_marks: 0 })
      .expect(422);
    expect(zero.body.errors).toEqual({
      max_marks: ['The max marks field must be at least 1.'],
    });
    expect(await assignmentCount()).toBe(before);
  });

  it('refuses a class the teacher does not teach (after validation)', async () => {
    const res = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('other'))
      .send({ class_id: Number(classId), title: 'Nope', max_marks: 10 })
      .expect(403);
    expect(res.body.message).toBe('You do not teach this class.');
    await http()
      .post('/api/v1/teacher/assignments')
      .set(as('s1'))
      .send({})
      .expect(403);
  });

  it('rejects attachments of the wrong type without creating a row', async () => {
    const before = await assignmentCount();
    const ext = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .field('class_id', String(classId))
      .field('title', 'Bad ext')
      .field('max_marks', '10')
      .attach('attachment', PDF, 'evil.exe')
      .expect(422);
    expect(ext.body.errors).toEqual({
      attachment: ['Extension .exe not allowed for doc.'],
    });
    // A .pdf name on PNG bytes: the sniffed type wins.
    const mime = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .field('class_id', String(classId))
      .field('title', 'Bad bytes')
      .field('max_marks', '10')
      .attach('attachment', PNG, 'sheet.pdf')
      .expect(422);
    expect(Object.keys(mime.body.errors)).toEqual(['attachment']);
    expect(mime.body.errors.attachment[0]).toMatch(
      /^MIME type image\/png does not match a permitted doc type\.$/,
    );
    // A forged link to our own /files/ path fails like Laravel's url rule.
    const forged = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .send({
        class_id: Number(classId),
        title: 'Forged',
        max_marks: 10,
        attachment_url: `http://files.e2e.test/files/assignments/${classId}/x.pdf?exp=1&sig=bad`,
      })
      .expect(422);
    expect(forged.body.errors).toEqual({
      attachment_url: ['The attachment url field must be a valid URL.'],
    });
    expect(await assignmentCount()).toBe(before);
  });

  let createdId: bigint;

  it('creates an assignment with a private attachment and notifies the class', async () => {
    const res = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .field('class_id', String(classId))
      .field('subject_id', String(subjectId))
      .field('title', `  Worksheet ${tag}  `)
      .field('description', 'Chapter 3')
      .field('due_date', '2030-01-15')
      .field('max_marks', '25')
      .attach('attachment', PDF, 'Work Sheet.pdf')
      .expect(201);
    expect(res.body.message).toBe('Assignment created.');
    expect(Object.keys(res.body.data)).toEqual(['id']);
    createdId = BigInt(res.body.data.id);

    const row = (await db.query.assignments.findFirst({
      where: eq(assignments.id, createdId),
    }))!;
    expect(row).toEqual(
      expect.objectContaining({
        teacher_id: u.teacher.id,
        class_id: classId,
        subject_id: subjectId,
        title: `Worksheet ${tag}`,
        description: 'Chapter 3',
        max_marks: 25,
        is_published: true,
      }),
    );
    expect(row.due_date?.toISOString()).toBe('2030-01-15T00:00:00.000Z');
    // Stored as a private key, never a signed URL.
    expect(row.attachment_url).toMatch(
      new RegExp(
        `^/files/assignments/${classId}/work-sheet-[A-Za-z0-9]{8}\\.pdf$`,
      ),
    );
    expect(
      existsSync(join(privateDir, row.attachment_url!.slice('/files/'.length))),
    ).toBe(true);

    // AssignmentPublished: one row per enrolled student, none for s3.
    const sent = await notificationsFor('AssignmentPublished', [
      u.s1.id,
      u.s2.id,
      u.s3.id,
    ]);
    expect(sent.map((n) => n.notifiable_id).sort()).toEqual(
      [u.s1.id, u.s2.id].sort(),
    );
    for (const n of sent) {
      expect(n.notifiable_type).toBe('App\\Models\\User');
      expect(n.read_at).toBeNull();
      const data = JSON.parse(n.data);
      expect(data).toEqual(
        expect.objectContaining({
          type: 'assignment.published',
          title: 'New assignment',
          body: `Worksheet ${tag}`,
        }),
      );
      expect(data.meta).toEqual(
        expect.objectContaining({
          assignment_id: Number(createdId),
          due_date: '2030-01-15T00:00:00+00:00',
        }),
      );
      expect(data.url).toMatch(
        new RegExp(`/student/assignments/${createdId}$`),
      );
    }
  });

  it('stores an attachment_url sent back as our own signed link as its key', async () => {
    const key = `assignments/${classId}/kept-${tag}.pdf`;
    const res = await http()
      .post('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .send({
        class_id: Number(classId),
        title: 'Signed back',
        max_marks: 5,
        attachment_url: signFileKey(key),
      })
      .expect(201);
    const row = (await db.query.assignments.findFirst({
      where: eq(assignments.id, BigInt(res.body.data.id)),
    }))!;
    expect(row.attachment_url).toBe(`/files/${key}`);
    expect(row.due_date).toBeNull();
    expect(row.subject_id).toBeNull();
  });

  it('lists only the teacher’s assignments with submission counts', async () => {
    const { body } = await http()
      .get('/api/v1/teacher/assignments')
      .set(as('teacher'))
      .expect(200);
    const ids = body.data.map((a: { id: number }) => BigInt(a.id));
    expect(ids).toContain(createdId);
    expect(ids).not.toContain(otherAssignmentId);
    const mine = body.data.find(
      (a: { id: number }) => BigInt(a.id) === createdId,
    );
    expect(Object.keys(mine)).toEqual([
      'id',
      'title',
      'class',
      'subject',
      'due_date',
      'max_marks',
      'submissions_count',
      'is_published',
    ]);
    expect(mine.subject).toBe(`Science ${tag}`);
    expect(mine.submissions_count).toBe(0);
  });

  // ── Detail ──

  let submissionId: bigint;

  it('shows the assignment with roster, submissions and a signed attachment', async () => {
    const now = new Date();
    const [sub] = await db
      .insert(assignment_submissions)
      .values({
        assignment_id: createdId,
        student_id: u.s2.id,
        status: 'submitted',
        note: 'done',
        submitted_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning();
    submissionId = sub.id;

    const { body } = await http()
      .get(`/api/v1/teacher/assignments/${createdId}`)
      .set(as('teacher'))
      .expect(200);
    const a = body.data.assignment;
    expect(BigInt(a.id)).toBe(createdId);
    expect(Object.keys(a).slice(-3)).toEqual([
      'klass',
      'subject',
      'submissions',
    ]);
    expect(a.attachment_url).toMatch(
      /^http:\/\/files\.e2e\.test\/files\/assignments\/\d+\/work-sheet-[A-Za-z0-9]{8}\.pdf\?exp=\d+&sig=[A-Za-z0-9_-]+$/,
    );
    expect(
      a.klass.students.map((s: { id: number }) => BigInt(s.id)).sort(),
    ).toEqual([u.s1.id, u.s2.id].sort());
    expect(a.klass.students[0]).not.toHaveProperty('password');
    expect(a.submissions).toHaveLength(1);
    expect(BigInt(a.submissions[0].student.id)).toBe(u.s2.id);
    // Roster sorted by name: Arjun (s2, submitted) before Zoya (s1, pending).
    expect(body.data.roster).toEqual([
      {
        student_id: Number(u.s2.id),
        name: `Arjun ${tag}`,
        submission_id: Number(submissionId),
        status: 'submitted',
        score: null,
        submitted_at: expect.any(String),
        graded: false,
      },
      {
        student_id: Number(u.s1.id),
        name: `Zoya ${tag}`,
        submission_id: null,
        status: 'pending',
        score: null,
        submitted_at: null,
        graded: false,
      },
    ]);
  });

  it('guards assignment detail: 404 unknown, 403 another teacher’s', async () => {
    const missing = await http()
      .get('/api/v1/teacher/assignments/99999999')
      .set(as('teacher'))
      .expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\Assignment] 99999999',
    );
    await http()
      .get(`/api/v1/teacher/assignments/${otherAssignmentId}`)
      .set(as('teacher'))
      .expect(403);
    await http()
      .get(`/api/v1/teacher/assignments/${createdId}`)
      .set(as('other'))
      .expect(403);
  });

  // ── Grading ──

  it('guards grading before validating: 404 unknown, 403 not the owner', async () => {
    const missing = await http()
      .post('/api/v1/teacher/submissions/99999999/grade')
      .set(as('teacher'))
      .send({})
      .expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\AssignmentSubmission] 99999999',
    );
    // Empty body still answers 403: the ownership check runs first.
    const forbidden = await http()
      .post(`/api/v1/teacher/submissions/${otherSubmissionId}/grade`)
      .set(as('teacher'))
      .send({})
      .expect(403);
    expect(forbidden.body.message).toBe('HTTP error');
    const untouched = (await db.query.assignment_submissions.findFirst({
      where: eq(assignment_submissions.id, otherSubmissionId),
    }))!;
    expect(untouched.status).toBe('submitted');
    expect(untouched.graded_at).toBeNull();
  });

  it('validates the grade', async () => {
    const path = `/api/v1/teacher/submissions/${submissionId}/grade`;
    const none = await http()
      .post(path)
      .set(as('teacher'))
      .send({})
      .expect(422);
    expect(none.body.errors).toEqual({
      score: ['The score field is required.'],
    });
    const neg = await http()
      .post(path)
      .set(as('teacher'))
      .send({ score: -1 })
      .expect(422);
    expect(neg.body.errors).toEqual({
      score: ['The score field must be at least 0.'],
    });
    const text = await http()
      .post(path)
      .set(as('teacher'))
      .send({ score: 'ten', feedback: ['x'] })
      .expect(422);
    expect(text.body.errors).toEqual({
      score: ['The score field must be an integer.'],
      feedback: ['The feedback field must be a string.'],
    });
    const row = (await db.query.assignment_submissions.findFirst({
      where: eq(assignment_submissions.id, submissionId),
    }))!;
    expect(row.status).toBe('submitted');
    expect(await notificationsFor('SubmissionGraded', [u.s2.id])).toHaveLength(
      0,
    );
  });

  it('grades a submission and notifies the student', async () => {
    const { body } = await http()
      .post(`/api/v1/teacher/submissions/${submissionId}/grade`)
      .set(as('teacher'))
      .send({ score: 18, feedback: 'Well done' })
      .expect(200);
    expect(body.message).toBe('Submission graded.');
    expect(body.data).toEqual({
      id: Number(submissionId),
      score: 18,
      status: 'graded',
      graded_at: expect.stringMatching(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/,
      ),
    });
    const row = (await db.query.assignment_submissions.findFirst({
      where: eq(assignment_submissions.id, submissionId),
    }))!;
    expect(row).toEqual(
      expect.objectContaining({
        score: 18,
        feedback: 'Well done',
        status: 'graded',
        graded_by: u.teacher.id,
      }),
    );
    expect(row.graded_at).toBeInstanceOf(Date);

    const sent = await notificationsFor('SubmissionGraded', [u.s1.id, u.s2.id]);
    expect(sent).toHaveLength(1);
    expect(sent[0].notifiable_id).toBe(u.s2.id);
    const data = JSON.parse(sent[0].data);
    expect(data).toEqual(
      expect.objectContaining({
        type: 'submission.graded',
        title: 'Assignment graded',
        body: `Worksheet ${tag} — 18/25`,
        meta: {
          submission_id: Number(submissionId),
          assignment_id: Number(createdId),
          score: 18,
          max_marks: 25,
        },
      }),
    );

    // The detail now shows the grade.
    const detail = await http()
      .get(`/api/v1/teacher/assignments/${createdId}`)
      .set(as('teacher'))
      .expect(200);
    expect(detail.body.data.roster[0]).toEqual(
      expect.objectContaining({ score: 18, status: 'graded', graded: true }),
    );
  });

  // ── Quizzes ──

  it('lists only the teacher’s quizzes with counts from SQL', async () => {
    const { body } = await http()
      .get('/api/v1/teacher/quizzes')
      .set(as('teacher'))
      .expect(200);
    expect(body.data).toHaveLength(1);
    const [q] = body.data;
    expect(Object.keys(q)).toEqual([
      'id',
      'title',
      'subject',
      'chapter',
      'duration_min',
      'total_marks',
      'questions_count',
      'attempts_count',
      'is_published',
    ]);
    const counts = await db.execute<{ questions: number; attempts: number }>(
      sql`select
            (select count(*)::int from questions where quiz_id = ${ownQuizId}) as questions,
            (select count(*)::int from quiz_attempts where quiz_id = ${ownQuizId}) as attempts`,
    );
    expect(q).toEqual({
      id: Number(ownQuizId),
      title: `Quiz ${tag}`,
      subject: `Science ${tag}`,
      chapter: null,
      duration_min: 20,
      total_marks: 10,
      questions_count: counts.rows[0].questions,
      attempts_count: counts.rows[0].attempts,
      is_published: true,
    });
    expect(q.questions_count).toBe(3);
    expect(q.attempts_count).toBe(4);
    const other = await http()
      .get('/api/v1/teacher/quizzes')
      .set(as('other'))
      .expect(200);
    expect(other.body.data.map((x: { id: number }) => BigInt(x.id))).toEqual([
      otherQuizId,
    ]);
  });

  it('computes quiz analytics over submitted attempts only', async () => {
    const { body } = await http()
      .get(`/api/v1/teacher/quizzes/${ownQuizId}/analytics`)
      .set(as('teacher'))
      .expect(200);
    expect(Object.keys(body.data)).toEqual(['quiz', 'stats', 'attempts']);
    expect(Object.keys(body.data.quiz).slice(-2)).toEqual([
      'subject',
      'chapter',
    ]);
    expect(body.data.quiz.chapter).toBeNull();
    const [ref] = (
      await db.execute<{
        attempts: number;
        avg: number;
        passed: number;
        hi: number;
        lo: number;
      }>(
        sql`select count(*)::int as attempts,
                   round(avg(case when a.total_marks > 0 then a.score * 100.0 / a.total_marks else 0 end))::int as avg,
                   (count(*) filter (where a.score >= q.pass_marks))::int as passed,
                   max(a.score)::int as hi, min(a.score)::int as lo
            from quiz_attempts a join quizzes q on q.id = a.quiz_id
            where a.quiz_id = ${ownQuizId} and a.status = 'submitted'`,
      )
    ).rows;
    expect(body.data.stats).toEqual({
      attempts: ref.attempts,
      avg_percent: ref.avg,
      pass_rate: Math.round((ref.passed / ref.attempts) * 100),
      highest: ref.hi,
      lowest: ref.lo,
    });
    // (80 + 30 + 50) / 3 = 53.3; 2 of 3 reach pass_marks 5.
    expect(body.data.stats).toEqual({
      attempts: 3,
      avg_percent: 53,
      pass_rate: 67,
      highest: 8,
      lowest: 3,
    });
    // Latest submission first.
    expect(
      body.data.attempts.map((a: { score: number; percent: number }) => [
        a.score,
        a.percent,
      ]),
    ).toEqual([
      [3, 30],
      [5, 50],
      [8, 80],
    ]);
    expect(body.data.attempts[0].student).toBe(`Arjun ${tag}`);
  });

  it('guards quiz analytics: 404 unknown, 403 another teacher’s, 403 students', async () => {
    const missing = await http()
      .get('/api/v1/teacher/quizzes/99999999/analytics')
      .set(as('teacher'))
      .expect(404);
    expect(missing.body.message).toBe(
      'No query results for model [App\\Models\\Quiz] 99999999',
    );
    await http()
      .get(`/api/v1/teacher/quizzes/${otherQuizId}/analytics`)
      .set(as('teacher'))
      .expect(403);
    await http().get('/api/v1/teacher/quizzes').set(as('s1')).expect(403);
    await http().get('/api/v1/teacher/quizzes').expect(401);
  });
});
