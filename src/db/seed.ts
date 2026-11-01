/**
 * not in legacy (as a Node script). `npm run db:seed`: fills an EMPTY database
 * with synthetic demo data, a port of the legacy seeders
 * (bodhiraai.com/database/seeders): DatabaseSeeder (School, User, Academic,
 * Syllabus, TeacherData, Cms), then Plan, IndividualStudent, MenuAndContent
 * and PageSeo. Not ported: Cbse10Content/Cbse10Videos (they point at a demo
 * file on the legacy disk) and BrandRename/BrandTextSweep (one-off data fixes).
 *
 * Everything is fictional: `@bodhira.test` / `.demo` addresses, made-up
 * names and phone numbers. Differences from the legacy seeders: the B2C
 * student has a made-up name and address (legacy used a real-looking one), the
 * extra schools get fixed phone numbers instead of random ones, and a content
 * manager and a web admin are added for the Web Studio.
 *
 * All demo accounts use the password `password` (legacy's), so this refuses to
 * run when NODE_ENV=production or when the users table has any row. Use
 * `npm run user:create-super-admin` for a real first account.
 */
process.env.TZ = 'UTC';

import { loadEnv } from '../config/env';
loadEnv();

import { asc, eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { phpJsonEncode } from '../common/http/laravel';
import { Role } from '../common/roles';
import { createDb, type Db } from './db';
import * as s from './schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const USER_MORPH = 'App\\Models\\User';
const now = new Date();
const stamps = () => ({ created_at: now, updated_at: now });
const daysFromNow = (d: number) => new Date(now.getTime() + d * 86_400_000);
/** Carbon::today()->subDays(n), as a DATE. */
const daysAgo = (d: number) => {
  const t = new Date(now);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - d * 86_400_000);
};
/** Str::slug for the ASCII titles used here. */
const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
/** A scalar site setting is stored as {"_": value} (SettingsService). */
const settingValue = (v: unknown) =>
  phpJsonEncode(v !== null && typeof v === 'object' ? v : { _: v });

// ------------------------------------------------------------ SchoolSeeder

const SCHOOLS = [
  {
    code: 'BDH001',
    name: 'Bodhira Demo School',
    slug: 'bodhira-demo',
    email: 'info@bodhira.demo',
    phone: '+919999900001',
    city: 'Hyderabad',
    state: 'Telangana',
    plan: 'pro',
    status: 'active',
  },
  {
    code: 'BDH002',
    name: 'Vidya Public School',
    slug: 'vidya-public',
    email: 'info@vidya.demo',
    phone: '+919999900002',
    city: 'Bengaluru',
    state: 'Karnataka',
    plan: 'free',
    status: 'active',
  },
  {
    code: 'BDH003',
    name: 'Sunrise International',
    slug: 'sunrise-intl',
    city: 'Mumbai',
    state: 'Maharashtra',
    plan: 'enterprise',
    expiresIn: 20,
    status: 'active',
  },
  {
    code: 'BDH004',
    name: 'Greenwood High',
    slug: 'greenwood-high',
    city: 'Chennai',
    state: 'Tamil Nadu',
    plan: 'starter',
    expiresIn: 45,
    status: 'active',
  },
  {
    code: 'BDH005',
    name: 'Ravindra Public',
    slug: 'ravindra-public',
    city: 'Pune',
    state: 'Maharashtra',
    plan: 'pro',
    expiresIn: 75,
    status: 'active',
  },
  {
    code: 'BDH006',
    name: 'St. Marys Academy',
    slug: 'st-marys',
    city: 'Kochi',
    state: 'Kerala',
    plan: 'starter',
    status: 'inactive',
  },
  {
    code: 'BDH007',
    name: 'New Horizons School',
    slug: 'new-horizons',
    city: 'Kolkata',
    state: 'West Bengal',
    plan: 'pro',
    expiresIn: 15,
    status: 'active',
  },
];

// ---------------------------------------------------------- AcademicSeeder

/** Public sample files (legacy's list). */
const SAMPLE_VIDEOS = [
  'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
  'https://www.w3schools.com/html/mov_bbb.mp4',
  'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4',
];
const SAMPLE_PDFS = [
  'https://www.africau.edu/images/default/sample.pdf',
  'https://www.orimi.com/pdf-test.pdf',
  'https://www.adobe.com/support/products/enterprise/knowledgecenter/media/c4611_sample_explain.pdf',
];

const SUBJECTS = [
  { name: 'Mathematics', icon: '🧮', color: '#06B6D4' },
  { name: 'Science', icon: '🔬', color: '#10B981' },
  { name: 'English', icon: '📖', color: '#F59E0B' },
  { name: 'Social Studies', icon: '🌏', color: '#EF4444' },
  { name: 'Computer Science', icon: '💻', color: '#8B5CF6' },
];

/** [title, duration_sec] for videos; the 4th lesson of each chapter is a PDF. */
type ChapterDef = [
  title: string,
  description: string,
  lessons: [string, number][],
  pdf: string,
];
const CHAPTERS: Record<string, ChapterDef[]> = {
  Mathematics: [
    [
      'Number Systems',
      'Rational and irrational numbers on the number line, real numbers and their operations.',
      [
        ['Introduction to Rational Numbers', 420],
        ['Irrational Numbers on the Number Line', 510],
        ['Operations on Real Numbers', 480],
      ],
      'Number Systems — Practice Sheet',
    ],
    [
      'Polynomials',
      'Degree, zeros, remainder theorem, and factor theorem with worked examples.',
      [
        ['What is a Polynomial?', 360],
        ['Zeros of Polynomials', 540],
        ['Factor Theorem with Examples', 600],
      ],
      'Polynomials Worksheet',
    ],
    [
      'Linear Equations',
      'Solving linear equations in one and two variables; graphing.',
      [
        ['Linear Equations in One Variable', 450],
        ['Linear Equations in Two Variables', 510],
        ['Graphing Linear Equations', 540],
      ],
      'Linear Equations — Practice Sheet',
    ],
  ],
  Science: [
    [
      'Matter Around Us',
      'States of matter, physical and chemical changes, mixtures and compounds.',
      [
        ['States of Matter', 480],
        ['Changes in States of Matter', 420],
        ['Mixtures vs Compounds', 540],
      ],
      'Lab Notes — Matter',
    ],
    [
      'Cell — The Unit of Life',
      'Discovery of the cell, plant vs animal cells, organelles and their functions.',
      [
        ['Discovery of the Cell', 360],
        ['Plant vs Animal Cells', 510],
        ['Cell Organelles', 600],
      ],
      'Cell Diagram Sheet',
    ],
    [
      'Motion',
      'Distance, displacement, speed, velocity, acceleration with worked numericals.',
      [
        ['Distance and Displacement', 420],
        ['Speed, Velocity, Acceleration', 540],
        ['Graphs of Motion', 510],
      ],
      'Motion — Numerical Problems',
    ],
  ],
  English: [
    [
      'The Lost Child',
      "Mulk Raj Anand's short story — characters, setting, and themes.",
      [
        ['Reading the Story Aloud', 540],
        ['Characters and Themes', 420],
        ["Author's Style and Symbolism", 480],
      ],
      'The Lost Child — Comprehension Sheet',
    ],
    [
      'Beehive Poems',
      'Selected poems from the NCERT Beehive textbook with poetic devices.',
      [
        ['The Road Not Taken — Robert Frost', 360],
        ['Wind — Subramania Bharati', 420],
        ['Rain on the Roof — Coates Kinney', 390],
      ],
      'Poetry Analysis Worksheet',
    ],
    [
      'Reading Skills',
      'Skimming, scanning, inferring meaning, and note-making practice.',
      [
        ['Skimming and Scanning', 300],
        ['Inferring Meaning from Context', 420],
        ['Effective Note Making', 480],
      ],
      'Practice Reading Passages',
    ],
  ],
  'Social Studies': [
    [
      'India — Size & Location',
      "India's position on the globe, neighbours, time zones, and physical features.",
      [
        ["India's Position on the Globe", 420],
        ['Neighbours and Borders', 480],
        ['Time Zones and Standard Meridian', 360],
      ],
      'India Map Activity Sheet',
    ],
    [
      'The French Revolution',
      'Causes, key events 1789-1794, outcomes, and global impact.',
      [
        ['Causes of the French Revolution', 540],
        ['Key Events 1789–1794', 600],
        ['Outcomes and Global Impact', 510],
      ],
      'French Revolution Timeline',
    ],
    [
      'Democracy in the Contemporary World',
      'Definition, features, and democracy around the world.',
      [
        ['What is Democracy?', 360],
        ['Features of Democracy', 480],
        ['Democracies Around the World', 540],
      ],
      'Democracy Case Study Sheet',
    ],
  ],
  'Computer Science': [
    [
      'Introduction to Computers',
      'History, components, and types of software with examples.',
      [
        ['A Brief History of Computing', 480],
        ['Components of a Computer System', 510],
        ['Types of Software', 420],
      ],
      'Computing Glossary Sheet',
    ],
    [
      'Data Representation',
      'Binary, ASCII, Unicode, and conversion techniques.',
      [
        ['The Binary Number System', 540],
        ['ASCII and Unicode Explained', 420],
        ['Decimal to Binary Conversion', 480],
      ],
      'Conversion Practice Sheet',
    ],
    [
      'Algorithms & Flowcharts',
      'Designing algorithms, drawing flowcharts, sample problems.',
      [
        ['What is an Algorithm?', 360],
        ['Drawing Flowcharts', 420],
        ['Sample Problem — Sum of N Numbers', 480],
      ],
      'Flowchart Exercise Sheet',
    ],
  ],
};

const noteFor = (subject: string, chapter: string, lesson: string) =>
  [
    'OVERVIEW',
    `In this lesson on "${lesson}" — part of ${chapter} in ${subject} — you'll build a clear, exam-ready understanding of the core idea and learn exactly how and where to apply it.`,
    '',
    'KEY POINTS',
    `• ${lesson} is a foundational concept in this chapter — get the definitions right first.`,
    '• Focus on the properties and the conditions under which each rule applies.',
    '• Work through the solved examples step by step before trying problems on your own.',
    `• Connect this topic back to what you already learned earlier in ${chapter}.`,
    '',
    'HOW TO APPROACH PROBLEMS',
    'Identify what is given and what is being asked, choose the right rule or formula, then solve one step at a time. Re-check every step and make sure your final answer is reasonable.',
    '',
    'COMMON MISTAKES',
    '• Skipping steps and losing track of signs or units.',
    '• Memorising without understanding why a rule works.',
    '• Not revising the note before attempting the quiz.',
    '',
    'SUMMARY',
    `You now know the essentials of "${lesson}". Revise these notes, practise a few problems, then take the chapter quiz to lock in your learning. Stuck anywhere? Use the AI Doubt Solver for instant help.`,
  ].join('\n');

// -------------------------------------------------------------- PlanSeeder

const PLANS = [
  {
    key: 'individual_basic',
    audience: 'individual',
    name: 'Individual Basic',
    tagline: 'Full syllabus access',
    description:
      'Everything a student needs to follow the syllabus end-to-end.',
    features: [
      'All chapters & lessons for your board + grade',
      'Quizzes with progress tracking',
      'Lesson notes & PDF worksheets',
      'Email support',
    ],
    monthly_price: 299,
    yearly_price: 2499,
    trial_days: 7,
    is_featured: false,
    sort_order: 10,
  },
  {
    key: 'individual_premium',
    audience: 'individual',
    name: 'Individual Premium',
    tagline: 'Everything, plus the AI tutor',
    description: 'For students who want unlimited AI help and downloads.',
    features: [
      'Everything in Basic',
      'AI doubt solver (unlimited)',
      'Downloadable PDFs',
      'Priority support',
    ],
    monthly_price: 599,
    yearly_price: 4999,
    trial_days: 7,
    is_featured: true,
    sort_order: 20,
  },
  {
    key: 'school_starter',
    audience: 'school',
    name: 'School Starter',
    tagline: 'Up to 5 classes',
    description: 'For small schools running a pilot.',
    features: ['5 classes', 'Email support', 'Quizzes & assignments'],
    monthly_price: 9999,
    yearly_price: 99999,
    trial_days: 0,
    is_featured: false,
    sort_order: 30,
  },
  {
    key: 'school_pro',
    audience: 'school',
    name: 'School Pro',
    tagline: 'Unlimited classes',
    description: 'For mid-sized schools.',
    features: [
      'Unlimited classes',
      'AI doubt solver',
      'Priority support',
      'Advanced analytics',
    ],
    monthly_price: 24999,
    yearly_price: 249999,
    trial_days: 0,
    is_featured: true,
    sort_order: 40,
  },
  {
    key: 'school_enterprise',
    audience: 'school',
    name: 'School Enterprise',
    tagline: 'Multi-campus',
    description: 'For enterprise/multi-campus deployments.',
    features: [
      'Multi-campus',
      'Dedicated support',
      'Custom integrations',
      'SLA',
    ],
    monthly_price: 99999,
    yearly_price: 999999,
    trial_days: 0,
    is_featured: false,
    sort_order: 50,
  },
];

// --------------------------------------------------------------- seeding

async function seedSchoolsAndUsers(tx: Tx, password: string) {
  const schoolIds: Record<string, bigint> = {};
  for (const [i, r] of SCHOOLS.entries()) {
    const [row] = await tx
      .insert(s.schools)
      .values({
        code: r.code,
        name: r.name,
        slug: r.slug,
        email: r.email ?? `${r.slug.replace(/ /g, '')}@bodhira.demo`,
        // Legacy used random numbers for the extra schools.
        phone: r.phone ?? `+91999990${String(i + 1).padStart(4, '0')}`,
        city: r.city,
        state: r.state,
        country: 'India',
        plan: r.plan,
        plan_expires_at: r.expiresIn ? daysFromNow(r.expiresIn) : null,
        status: r.status,
        ...stamps(),
      })
      .returning({ id: s.schools.id });
    schoolIds[r.code] = row.id;
  }
  const demo = schoolIds.BDH001;

  const user = async (v: Partial<typeof s.users.$inferInsert>) => {
    const [row] = await tx
      .insert(s.users)
      .values({
        name: '',
        password,
        status: 'active',
        ...v,
        ...stamps(),
      } as typeof s.users.$inferInsert)
      .returning({ id: s.users.id });
    return row.id;
  };
  const users = {
    super: await user({
      email: 'super@bodhira.test',
      name: 'Platform Super Admin',
      phone: '+911000000001',
      username: 'super',
      role: Role.SuperAdmin,
    }),
    admin: await user({
      email: 'admin@bodhira.test',
      name: 'School Admin',
      phone: '+911000000002',
      username: 'admin',
      school_id: demo,
      role: Role.Admin,
    }),
    teacher: await user({
      email: 'teacher@bodhira.test',
      name: 'Anita Sharma',
      phone: '+911000000003',
      username: 'anita',
      school_id: demo,
      role: Role.Teacher,
      gender: 'female',
    }),
    // Option A: no phone of their own, a school-issued username.
    student: await user({
      email: 'student@bodhira.test',
      name: 'Rahul Verma',
      phone: null,
      username: 'bdh001-9-rahul',
      school_id: demo,
      role: Role.Student,
      grade: '9',
      gender: 'male',
      dob: new Date('2011-04-15T00:00:00Z'),
    }),
    parent: await user({
      email: 'parent@bodhira.test',
      name: 'Suresh Verma',
      phone: '+911000000005',
      username: 'suresh',
      school_id: demo,
      role: Role.Parent,
    }),
    // not in legacy seeders: Web Studio roles for the demo.
    cms: await user({
      email: 'cms@bodhira.test',
      name: 'Content Manager',
      phone: '+911000000006',
      username: 'cms',
      role: Role.ContentManager,
    }),
    webAdmin: await user({
      email: 'webadmin@bodhira.test',
      name: 'Web Admin',
      phone: '+911000000007',
      username: 'webadmin',
      role: Role.WebAdmin,
    }),
  };
  await tx.insert(s.parent_student).values({
    parent_id: users.parent,
    student_id: users.student,
    relation: 'father',
    ...stamps(),
  });
  const [klass] = await tx
    .insert(s.classes)
    .values({
      school_id: demo,
      grade: '9',
      section: 'A',
      academic_year: '2026-27',
      class_teacher_id: users.teacher,
      ...stamps(),
    })
    .returning({ id: s.classes.id });
  await tx.insert(s.class_student).values({
    class_id: klass.id,
    student_id: users.student,
    roll_no: '09A01',
    ...stamps(),
  });
  return { schoolIds, users, classId: klass.id };
}

async function seedAcademics(
  tx: Tx,
  schoolId: bigint,
  teacherId: bigint,
  classId: bigint,
) {
  let videoCursor = 0;
  let pdfCursor = 0;
  for (const [i, subj] of SUBJECTS.entries()) {
    const [subject] = await tx
      .insert(s.subjects)
      .values({
        school_id: schoolId,
        slug: slug(subj.name),
        grade: '9',
        name: subj.name,
        icon: subj.icon,
        color: subj.color,
        description: `Grade 9 ${subj.name} syllabus aligned with NCERT.`,
        sort_order: i + 1,
        is_active: true,
        ...stamps(),
      })
      .returning({ id: s.subjects.id });
    await tx.insert(s.class_subject).values({
      class_id: classId,
      subject_id: subject.id,
      teacher_id: teacherId,
      ...stamps(),
    });

    for (const [c, [title, description, videos, pdf]] of CHAPTERS[
      subj.name
    ].entries()) {
      const cNum = c + 1;
      const chapterTitle = `Chapter ${cNum}: ${title}`;
      const [chapter] = await tx
        .insert(s.chapters)
        .values({
          subject_id: subject.id,
          slug: slug(`ch-${cNum}-${subj.name}`),
          title: chapterTitle,
          description,
          sort_order: cNum,
          is_published: true,
          ...stamps(),
        })
        .returning({ id: s.chapters.id });
      const lessons: [string, number | null][] = [...videos, [pdf, null]];
      for (const [l, [lessonTitle, duration]] of lessons.entries()) {
        const lNum = l + 1;
        const isVideo = duration !== null;
        await tx.insert(s.lessons).values({
          chapter_id: chapter.id,
          slug: slug(`lesson-${cNum}-${lNum}-${subj.name}`),
          title: `${cNum}.${lNum} ${lessonTitle}`,
          type: isVideo ? 'video' : 'pdf',
          thumbnail: isVideo
            ? `https://picsum.photos/seed/${slug(`${subj.name}-${cNum}-${lNum}`)}/640/360`
            : null,
          content_url: isVideo
            ? SAMPLE_VIDEOS[videoCursor++ % SAMPLE_VIDEOS.length]
            : SAMPLE_PDFS[pdfCursor++ % SAMPLE_PDFS.length],
          content_body: noteFor(subj.name, title, lessonTitle),
          duration_sec: duration ?? 0,
          sort_order: lNum,
          is_free: lNum === 1, // first lesson of every chapter is free
          is_published: true,
          ...stamps(),
        });
      }
      const [quiz] = await tx
        .insert(s.quizzes)
        .values({
          subject_id: subject.id,
          chapter_id: chapter.id,
          title: `Quiz - ${chapterTitle}`,
          school_id: schoolId,
          created_by: teacherId,
          description: 'Quick check of your understanding.',
          duration_min: 10,
          total_marks: 10,
          pass_marks: 4,
          is_published: true,
          ...stamps(),
        })
        .returning({ id: s.quizzes.id });
      await tx.insert(s.questions).values(
        [1, 2, 3, 4, 5].map((q) => ({
          quiz_id: quiz.id,
          body: `Sample question ${q} for ${chapterTitle}?`,
          type: 'mcq',
          marks: 2,
          options: phpJsonEncode(
            ['A', 'B', 'C', 'D'].map((key) => ({ key, text: `Option ${key}` })),
          ),
          correct_answer: phpJsonEncode(['B']),
          sort_order: q,
          ...stamps(),
        })),
      );
    }
  }
}

async function seedSyllabi(tx: Tx, schoolId: bigint) {
  const boards = [
    {
      board: 'CBSE',
      grade: '9',
      name: 'CBSE Grade 9',
      sort_order: 10,
      description: 'NCERT-aligned CBSE syllabus for Class 9.',
    },
    {
      board: 'ICSE',
      grade: '9',
      name: 'ICSE Grade 9',
      sort_order: 20,
      description: 'ICSE Class 9 syllabus.',
    },
    {
      board: 'STATE_MH',
      grade: '9',
      name: 'Maharashtra State Board · Grade 9',
      sort_order: 30,
      description: 'Maharashtra SSC Board Class 9 syllabus.',
    },
    {
      board: 'CBSE',
      grade: '10',
      name: 'CBSE Grade 10',
      sort_order: 40,
      description: 'NCERT-aligned CBSE syllabus for Class 10.',
    },
  ];
  const ids: Record<string, bigint> = {};
  for (const b of boards) {
    const [row] = await tx
      .insert(s.syllabi)
      .values({
        ...b,
        slug: `${b.board.toLowerCase().replace(/_/g, '-')}-grade-${b.grade}`,
        is_active: true,
        ...stamps(),
      })
      .returning({ id: s.syllabi.id });
    ids[`${b.board}-${b.grade}`] = row.id;
  }
  // The demo school's grade 9 subjects serve CBSE 9 (B2B and B2C).
  await tx
    .update(s.subjects)
    .set({ syllabus_id: ids['CBSE-9'] })
    .where(eq(s.subjects.school_id, schoolId));
  await tx
    .insert(s.school_syllabus)
    .values({ school_id: schoolId, syllabus_id: ids['CBSE-9'], ...stamps() });
  return ids;
}

async function seedTeacherData(
  tx: Tx,
  teacherId: bigint,
  studentId: bigint,
  classId: bigint,
  schoolId: bigint,
) {
  const math = await tx.query.subjects.findFirst({
    where: (t, { and }) =>
      and(eq(t.school_id, schoolId), eq(t.name, 'Mathematics')),
    orderBy: [asc(s.subjects.id)],
  });
  const [a1] = await tx
    .insert(s.assignments)
    .values([
      {
        teacher_id: teacherId,
        class_id: classId,
        title: 'Chapter 1 Practice Sheet',
        subject_id: math?.id,
        description: 'Solve problems 1-15 from Number Systems exercise.',
        due_date: daysFromNow(7),
        max_marks: 50,
        is_published: true,
        ...stamps(),
      },
      {
        teacher_id: teacherId,
        class_id: classId,
        title: 'Polynomials Worksheet',
        subject_id: math?.id,
        description: 'Worksheet covering polynomial operations.',
        due_date: daysFromNow(14),
        max_marks: 30,
        is_published: true,
        ...stamps(),
      },
    ])
    .returning({ id: s.assignments.id });
  await tx.insert(s.assignment_submissions).values({
    assignment_id: a1.id,
    student_id: studentId,
    note: 'Completed all problems. Q11 was tricky — used substitution method.',
    status: 'submitted',
    submitted_at: new Date(now.getTime() - 3 * 3_600_000),
    ...stamps(),
  });
  await tx.insert(s.attendance).values(
    [1, 2, 3, 4, 5].map((i) => ({
      class_id: classId,
      student_id: studentId,
      date: daysAgo(i),
      status: i === 2 ? 'absent' : 'present',
      marked_by: teacherId,
      ...stamps(),
    })),
  );
  if (!math) return;

  const chapter = await tx.query.chapters.findFirst({
    where: eq(s.chapters.subject_id, math.id),
    orderBy: [asc(s.chapters.id)],
  });
  const lesson =
    chapter &&
    (await tx.query.lessons.findFirst({
      where: eq(s.lessons.chapter_id, chapter.id),
      orderBy: [asc(s.lessons.id)],
    }));
  const hourAgo = new Date(now.getTime() - 3_600_000);
  if (lesson)
    await tx.insert(s.lesson_progress).values({
      student_id: studentId,
      lesson_id: lesson.id,
      status: 'completed',
      watched_seconds: lesson.duration_sec,
      progress_percent: 100,
      last_viewed_at: hourAgo,
      completed_at: hourAgo,
      ...stamps(),
    });

  const quiz = await tx.query.quizzes.findFirst({
    where: (t, { and }) =>
      and(eq(t.subject_id, math.id), eq(t.created_by, teacherId)),
    orderBy: [asc(s.quizzes.id)],
  });
  if (!quiz) return;
  const questions = await tx.query.questions.findMany({
    where: eq(s.questions.quiz_id, quiz.id),
    orderBy: [asc(s.questions.id)],
  });
  const [attempt] = await tx
    .insert(s.quiz_attempts)
    .values({
      quiz_id: quiz.id,
      student_id: studentId,
      status: 'submitted',
      total_marks: quiz.total_marks,
      started_at: new Date(now.getTime() - 20 * 60_000),
      submitted_at: new Date(now.getTime() - 10 * 60_000),
      score: 0,
      ...stamps(),
    })
    .returning({ id: s.quiz_attempts.id });
  let score = 0;
  for (const [i, q] of questions.entries()) {
    const correct = i % 2 === 0;
    await tx.insert(s.quiz_answers).values({
      attempt_id: attempt.id,
      question_id: q.id,
      answer: correct ? q.correct_answer : phpJsonEncode(['Z']),
      is_correct: correct,
      marks_awarded: correct ? q.marks : 0,
      ...stamps(),
    });
    if (correct) score += q.marks ?? 0;
  }
  await tx
    .update(s.quiz_attempts)
    .set({ score })
    .where(eq(s.quiz_attempts.id, attempt.id));
}

async function seedPlansAndIndividual(
  tx: Tx,
  password: string,
  cbse10: bigint,
) {
  await tx.insert(s.plans).values(
    PLANS.map((p) => ({
      ...p,
      features: phpJsonEncode(p.features),
      is_active: true,
      ...stamps(),
    })),
  );
  // A self-enrolled (B2C) student with an active individual subscription.
  // Legacy's IndividualStudentSeeder used a real-looking name; this one is made up.
  const [b2c] = await tx
    .insert(s.users)
    .values({
      email: 'individual@bodhira.test',
      name: 'Kiran Demo',
      username: 'bdh-individual',
      role: Role.Student,
      school_id: null,
      syllabus_id: cbse10,
      grade: '10',
      status: 'active',
      password,
      ...stamps(),
    })
    .returning({ id: s.users.id });
  await tx.insert(s.subscriptions).values({
    subscribable_type: USER_MORPH,
    subscribable_id: b2c.id,
    plan: 'individual_basic',
    status: 'active',
    trial_ends_at: null,
    current_period_start: daysAgo(0),
    current_period_end: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()),
    ),
    meta: phpJsonEncode({ cycle: 'monthly', demo: true, gateway: 'demo' }),
    ...stamps(),
  });
}

async function seedCms(tx: Tx, authorId: bigint) {
  // CmsSeeder::settings()
  const settings: Record<string, unknown> = {
    'general.site_name': 'Bodhira.ai',
    'general.tagline': 'Modern Digital Learning for Schools',
    'general.logo_light': '/assets/img/logo.png',
    'general.logo_dark': '/assets/img/logo-white.png',
    'general.favicon': '/assets/img/favicon.png',
    'general.default_og': '/assets/img/og-default.png',
    'brand.primary_color': '#C49560',
    'brand.secondary_color': '#2A0E13',
    'brand.accent_color': '#EF4444',
    'brand.font_display': 'Poppins',
    'brand.font_body': 'Inter',
    'contact.email': 'hello@bodhira.com',
    'contact.phone': '+91 90000 00000',
    'contact.whatsapp': '+91 90000 00000',
    'contact.address': 'Hyderabad, Telangana, India',
    'contact.map_embed': '',
    'seo.title_suffix': ' — Bodhira.ai',
    'seo.meta_description':
      'One smart platform for every subject, every class, every student.',
    'seo.robots': 'index, follow',
    'seo.ga_id': '',
    'seo.gtm_id': '',
    'seo.fb_pixel': '',
    'seo.sitemap_enabled': true,
    'footer.about':
      'Bodhira.ai is a modern learning platform built around the way your school already teaches.',
    'footer.copyright': `© ${now.getUTCFullYear()} Bodhira.ai. All rights reserved.`,
    'theme.mode': 'light',
    'theme.radius': '16',
  };
  await tx.insert(s.site_settings).values(
    Object.entries(settings).map(([k, v]) => {
      const at = k.indexOf('.');
      return {
        group: k.slice(0, at),
        key: k.slice(at + 1),
        value: settingValue(v),
        ...stamps(),
      };
    }),
  );

  // Navigation: CmsSeeder's footer; the header as MenuAndContentSeeder left it.
  const [header] = await tx
    .insert(s.navigation_menus)
    .values({ key: 'header', name: 'Header Menu', ...stamps() })
    .returning({ id: s.navigation_menus.id });
  const [footer] = await tx
    .insert(s.navigation_menus)
    .values({ key: 'footer_primary', name: 'Footer — Company', ...stamps() })
    .returning({ id: s.navigation_menus.id });
  const headerItems = [
    ['Home', '/'],
    ['About Us', '/about'],
    ['Courses', '/courses'],
    ['LMS Platform', '/features'],
    ['Success Stories', '/success-stories'],
    ['Blogs & Articles', '/blog'],
    ['Pricing', '/pricing'],
    ['FAQ', '/faq'],
    ['Contact Us', '/contact'],
  ];
  const footerItems = [
    ['About Us', '/about'],
    ['Features', '/features'],
    ['Pricing', '/pricing'],
    ['Privacy Policy', '/privacy'],
    ['Terms', '/terms'],
  ];
  await tx.insert(s.menu_items).values([
    ...headerItems.map(([label, url], i) => ({
      navigation_menu_id: header.id,
      label,
      url,
      target: '_self',
      sort_order: i,
      is_active: true,
      ...stamps(),
    })),
    ...footerItems.map(([label, url], i) => ({
      navigation_menu_id: footer.id,
      label,
      url,
      sort_order: i,
      is_active: true,
      ...stamps(),
    })),
  ]);

  await tx.insert(s.social_links).values(
    [
      ['facebook', 'https://facebook.com/bodhira', 'fab fa-facebook-f'],
      ['x', 'https://x.com/bodhira', 'fab fa-x-twitter'],
      ['instagram', 'https://instagram.com/bodhira', 'fab fa-instagram'],
      [
        'linkedin',
        'https://linkedin.com/company/bodhira',
        'fab fa-linkedin-in',
      ],
      ['youtube', 'https://youtube.com/@bodhira', 'fab fa-youtube'],
    ].map(([platform, url, icon], i) => ({
      platform,
      url,
      icon,
      sort_order: i,
      is_active: true,
      ...stamps(),
    })),
  );

  await tx.insert(s.services).values(
    [
      [
        'fa-book-open',
        'Full Syllabus Library',
        'CBSE, ICSE & State boards — chapters, lessons and notes for every class.',
      ],
      [
        'fa-video',
        'Live & Recorded Classes',
        'Teachers run live sessions; students rewatch anytime.',
      ],
      [
        'fa-robot',
        'AI Doubt Solver',
        'Instant, syllabus-aware answers to student questions, 24/7.',
      ],
      [
        'fa-chart-line',
        'Progress Analytics',
        'See every student. Help every student. Real-time insight for teachers & parents.',
      ],
    ].map(([icon, title, excerpt], i) => ({
      slug: slug(title),
      icon,
      title,
      excerpt,
      sort_order: i,
      is_active: true,
      is_featured: i < 3,
      ...stamps(),
    })),
  );
  await tx.insert(s.features).values(
    [
      [
        'fa-layer-group',
        'Built around your syllabus',
        'Everything maps to the board and grade you already teach.',
      ],
      [
        'fa-users',
        'One platform for everyone',
        'Students, teachers and parents in a single connected workspace.',
      ],
      [
        'fa-shield-halved',
        'Safe & private',
        'DPDP-compliant, role-based access and audited admin actions.',
      ],
      [
        'fa-mobile-screen',
        'Works on any device',
        'Mobile-first web plus native apps — learning anywhere.',
      ],
    ].map(([icon, title, description], i) => ({
      icon,
      title,
      description,
      sort_order: i,
      is_active: true,
      ...stamps(),
    })),
  );
  // CmsSeeder's FAQs, then MenuAndContentSeeder's (different questions).
  const faqs = [
    [
      'General',
      'Which boards do you support?',
      'CBSE, ICSE and major State boards, with more added regularly.',
      0,
    ],
    [
      'General',
      'Can parents track progress?',
      'Yes — parents get a dedicated dashboard with attendance, marks and activity.',
      1,
    ],
    [
      'General',
      'Is there a free trial?',
      'Most plans include a trial. See the Pricing page for current offers.',
      2,
    ],
    [
      'General',
      'Do teachers need training?',
      'No — the platform mirrors how schools already teach, so onboarding is quick.',
      3,
    ],
    [
      'General',
      'What is Bodhira.ai?',
      'Bodhira.ai is a complete digital learning platform for schools — combining visual video lessons, an AI learning assistant, smart assessments, attendance, assignments and parent engagement in one place.',
      0,
    ],
    [
      'General',
      'Which classes and boards do you support?',
      'Bodhira.ai covers Class 1 to Class 12 across major subjects, aligned to CBSE and state curricula.',
      1,
    ],
    [
      'General',
      'Does Bodhira.ai work on a mobile phone?',
      'Yes. Bodhira.ai is mobile-first. Students can watch lessons, take quizzes and ask the AI on a phone, tablet or laptop — videos resume where they paused, even on another device.',
      2,
    ],
    [
      'For Students',
      'How does the “Ask AI” feature work?',
      "While watching a lesson, a student can click “Ask AI”, type a question and get a clear explanation in simple words. The AI uses that lesson's content, so the answer always matches what the student is studying.",
      3,
    ],
    [
      'For Students',
      'What happens after each lesson?',
      'Each topic ends with an auto-graded quiz. Scores appear instantly and weak areas are flagged so students know exactly what to revise.',
      4,
    ],
    [
      'For Parents',
      'Do parents get their own login?',
      'Yes. Each parent gets a separate login linked to their child and can see lessons watched, quiz scores, weak subjects, attendance and teacher notes in real time.',
      5,
    ],
    [
      'For Schools',
      'How do schools get started?',
      'Book a demo and our team sets up your classes, sections and a school-admin login, then helps you add students and map teachers to subjects — usually within a week.',
      6,
    ],
    [
      'For Schools',
      'Is our data secure?',
      "Yes. Data is encrypted in transit and at rest, access is role-based, and we comply with India's Digital Personal Data Protection Act, 2023.",
      7,
    ],
  ] as const;
  await tx.insert(s.faqs).values(
    faqs.map(([category, question, answer, sort_order]) => ({
      category,
      question,
      answer,
      sort_order,
      is_active: true,
      ...stamps(),
    })),
  );
  await tx.insert(s.testimonials).values(
    [
      [
        'Anjali Rao',
        'Principal',
        'Sunrise Public School',
        'Bodhira.ai fit into how we already teach — adoption was effortless and parents love the visibility.',
      ],
      [
        'Vikram Mehta',
        'Parent',
        '',
        'I finally see how my daughter is doing every week, not just at exam time.',
      ],
      [
        'Sara Iqbal',
        'Teacher',
        'Greenwood High',
        'Live classes, quizzes and the AI doubt-solver in one place saves me hours every week.',
      ],
    ].map(([name, role, company, quote], i) => ({
      name,
      role,
      company,
      quote,
      rating: 5,
      sort_order: i,
      is_featured: true,
      is_active: true,
      ...stamps(),
    })),
  );
  await tx.insert(s.team_members).values(
    [
      ['Founder Name', 'Founder & CEO'],
      ['CTO Name', 'Chief Technology Officer'],
      ['Head of Curriculum', 'Academics'],
    ].map(([name, role], i) => ({
      name,
      role,
      sort_order: i,
      is_active: true,
      ...stamps(),
    })),
  );

  await seedPages(tx);

  // Blog (CmsSeeder) and success stories (MenuAndContentSeeder).
  const [news] = await tx
    .insert(s.blog_categories)
    .values({
      slug: 'announcements',
      name: 'Announcements',
      description: 'Product news and updates',
      is_active: true,
      ...stamps(),
    })
    .returning({ id: s.blog_categories.id });
  const [stories] = await tx
    .insert(s.blog_categories)
    .values({
      slug: 'success-stories',
      name: 'Success Stories',
      description: 'Real results from schools using Bodhira.ai.',
      sort_order: 1,
      is_active: true,
      ...stamps(),
    })
    .returning({ id: s.blog_categories.id });
  const posts = [
    [
      'Welcome to the new Bodhira.ai',
      'A faster, fully dynamic platform for schools.',
    ],
    [
      'Live classes, reimagined',
      'How our new live class engine helps teachers.',
    ],
    ['Helping parents stay involved', 'The parent dashboard explained.'],
  ];
  await tx.insert(s.blog_posts).values(
    posts.map(([title, excerpt], i) => ({
      blog_category_id: news.id,
      author_id: authorId,
      slug: slug(title),
      title,
      excerpt,
      body: `<p>${excerpt}</p><p>Full article content is managed from the CMS.</p>`,
      status: 'published',
      published_at: daysFromNow(-i),
      is_featured: i === 0,
      reading_minutes: 3,
      ...stamps(),
    })),
  );
  const storyRows = [
    [
      'How a CBSE School Cut Doubt-Clearing Time in Half',
      'A 1,200-student school used visual lessons and the AI assistant to help students resolve doubts instantly — freeing teachers for deeper teaching.',
    ],
    [
      "Parents Finally See Their Child's Progress in Real Time",
      'With the parent dashboard, families track lessons watched, quiz scores and weak areas — and attendance — without calling the school.',
    ],
    [
      'From Chalkboard to Visual Learning in One Term',
      'A government-aided school adopted Bodhira.ai and saw measurable gains in engagement and test scores within a single academic term.',
    ],
  ];
  await tx.insert(s.blog_posts).values(
    storyRows.map(([title, excerpt], i) => ({
      blog_category_id: stories.id,
      slug: slug(title),
      title,
      excerpt,
      body: `<p>${excerpt}</p><p>This is a sample success story. Replace it from the CMS → Blog manager with your real case study, photos and outcomes.</p>`,
      status: 'published',
      published_at: new Date(Date.UTC(2026, 5, 1) - i * 5 * 86_400_000),
      reading_minutes: 3,
      ...stamps(),
    })),
  );
}

/** CmsSeeder::pages(), with the SEO of PageSeoSeeder and MenuAndContentSeeder. */
async function seedPages(tx: Tx) {
  const seo: Record<string, [string, string, string]> = {
    home: [
      'Bodhira.ai — Visual Learning & AI-Powered Education Platform for Schools',
      'Bodhira.ai is a complete digital learning ecosystem with visual lessons, an AI learning assistant, smart assessments, attendance and parent engagement — helping every child Learn, Visualize, Understand and Excel.',
      'Bodhira.ai, visual learning platform, AI learning assistant, school LMS, CBSE learning app, online education India, smart assessments, student performance analytics, school management software',
    ],
    about: [
      'About Bodhira.ai — Our Vision & Mission for Modern Education',
      'Discover how Bodhira.ai empowers schools, teachers, students and parents with a unified platform built for understanding, not memorisation. Every child can see, experience and excel.',
      'about Bodhira.ai, education vision, edtech mission, visual learning, unified school platform, modern education India',
    ],
    features: [
      'Features — Visual Learning, AI Assistant & School Management | Bodhira.ai',
      'Explore Bodhira.ai features: visual learning experiences, AI learning assistant, smart assessments, attendance management, assignments, parent engagement portal, teacher tools, analytics and mobile learning.',
      'Bodhira.ai features, AI learning assistant, visual learning, smart assessments, attendance management, school management software, student performance analytics, parent portal',
    ],
    contact: [
      'Contact Bodhira.ai — Book a Free Demo for Your School',
      'Get in touch with the Bodhira.ai team. Book a free demo and see how our visual, AI-powered learning platform transforms teaching and learning in your school.',
      'contact Bodhira.ai, book a demo, school demo, edtech contact, Bodhira support, learning platform demo',
    ],
    pricing: [
      'Pricing & Plans — Bodhira.ai Learning Platform for Schools',
      'Flexible plans for schools of every size. Bring visual learning, an AI learning assistant and complete school management to your classrooms with Bodhira.ai.',
      'Bodhira.ai pricing, school LMS pricing, edtech plans, learning platform cost, school software pricing India',
    ],
    blog: [
      'Blog — Insights on Visual Learning, AI & EdTech | Bodhira.ai',
      'Ideas, tips and insights on teaching, visual learning, AI in education and modern classroom technology from the Bodhira.ai team.',
      'Bodhira.ai blog, edtech blog, visual learning, AI in education, teaching tips, classroom technology',
    ],
    courses: [
      'Courses — Every Subject, Every Class | Bodhira.ai',
      'Explore Bodhira.ai courses: visual video lessons, notes, quizzes and an AI assistant across Maths, Science, English, Social Studies and more — Class 1 to 12.',
      'Bodhira.ai courses, online courses for schools, CBSE video lessons, class 10 courses, visual learning subjects',
    ],
    faq: [
      'FAQ — Frequently Asked Questions | Bodhira.ai',
      'Answers to common questions about Bodhira.ai — features, AI learning assistant, parent access, school onboarding, pricing and data security.',
      'Bodhira.ai FAQ, frequently asked questions, school LMS questions, AI learning assistant FAQ',
    ],
    'success-stories': [
      'Success Stories — Schools Growing with Bodhira.ai',
      'Real stories from schools, teachers and parents who transformed learning with Bodhira.ai — visual lessons, AI support and measurable results.',
      'Bodhira.ai success stories, school case studies, edtech results, visual learning outcomes',
    ],
  };
  const page = async (
    slugValue: string,
    name: string,
    template: string,
    sort_order = 0,
  ) => {
    const [meta_title, meta_description, meta_keywords] = seo[slugValue];
    const [row] = await tx
      .insert(s.pages)
      .values({
        slug: slugValue,
        name,
        template,
        status: 'published',
        is_system: true,
        meta_title,
        meta_description,
        meta_keywords,
        sort_order,
        ...stamps(),
      })
      .returning({ id: s.pages.id });
    return row.id;
  };
  type Section = {
    type: string;
    eyebrow?: string;
    heading?: string;
    subheading?: string;
    body?: string;
    data?: unknown;
  };
  const sections = (pageId: bigint, list: Section[]) =>
    tx.insert(s.page_sections).values(
      list.map((x, i) => ({
        page_id: pageId,
        ...x,
        data: x.data === undefined ? null : phpJsonEncode(x.data),
        sort_order: i,
        is_active: true,
        ...stamps(),
      })),
    );

  const cta = { label: 'Get Started', url: '/register/student' };
  await sections(await page('home', 'Home', 'home'), [
    {
      type: 'hero',
      eyebrow: 'Bodhira.ai',
      heading:
        'One Smart Platform for Every Subject, Every Class, Every Student',
      subheading:
        'Live classes, full syllabus, AI doubt-solving and progress tracking — built around the way your school already teaches.',
      data: {
        primary_cta: cta,
        secondary_cta: { label: 'Watch demo', url: '#demo' },
      },
    },
    {
      type: 'stats',
      heading: 'Trusted by schools',
      data: {
        items: [
          { value: '7+', label: 'Schools' },
          { value: '50k+', label: 'Lessons delivered' },
          { value: '12', label: 'Modules' },
          { value: '99.9%', label: 'Uptime' },
        ],
      },
    },
    {
      type: 'about',
      eyebrow: 'How it works',
      heading: 'How Bodhira.ai Works for Your School, Students & Parents',
      body: 'A single connected workspace where teachers teach, students learn, and parents stay informed.',
    },
    {
      type: 'services',
      eyebrow: 'What you get',
      heading: 'Every Major Subject. Every Class. One Platform.',
    },
    {
      type: 'features',
      eyebrow: 'Why Bodhira.ai',
      heading: 'Built Around the Way Your School Already Teaches',
    },
    {
      type: 'testimonials',
      eyebrow: 'Loved by educators',
      heading: 'See Every Student. Help Every Student.',
    },
    {
      type: 'faq',
      eyebrow: 'Questions',
      heading: 'Frequently Asked Questions',
    },
    {
      type: 'cta',
      heading: 'Ready to bring your school online?',
      subheading: 'Start in minutes — no credit card required.',
      data: { primary_cta: cta },
    },
  ]);
  const simple: [string, string, string, string][] = [
    [
      'about',
      'About',
      'About Bodhira.ai',
      'Modern learning, built for Indian classrooms.',
    ],
    [
      'features',
      'Features',
      'Everything your school needs',
      'A complete toolkit for teaching, learning and reporting.',
    ],
    [
      'contact',
      'Contact',
      'Talk to us',
      'We usually reply within one business day.',
    ],
    [
      'blog',
      'Blog',
      'Bodhira.ai Blog',
      'Ideas on teaching, learning and EdTech.',
    ],
  ];
  for (const [slugValue, name, heading, subheading] of simple) {
    const id = await page(slugValue, name, 'default');
    const list: Section[] = [{ type: 'hero', heading, subheading }];
    if (slugValue === 'contact')
      list.push({ type: 'contact_form', heading: 'Send us a message' });
    await sections(id, list);
  }
  await page('pricing', 'Pricing', 'default');
  await page('courses', 'Courses', 'default');
  await page('faq', 'FAQ', 'default');
  await page('success-stories', 'Success Stories', 'default');
}

export async function seed(db: Db, env = process.env) {
  if (env.NODE_ENV === 'production')
    throw new Error('Refusing to seed demo data when NODE_ENV=production');
  if ((await db.$count(s.users)) > 0)
    throw new Error(
      'Refusing to seed: the users table is not empty (db:seed is for an empty database)',
    );
  const password = await hashPassword('password');
  await db.transaction(async (tx) => {
    const { schoolIds, users, classId } = await seedSchoolsAndUsers(
      tx,
      password,
    );
    await seedAcademics(tx, schoolIds.BDH001, users.teacher, classId);
    const syllabi = await seedSyllabi(tx, schoolIds.BDH001);
    await seedTeacherData(
      tx,
      users.teacher,
      users.student,
      classId,
      schoolIds.BDH001,
    );
    await seedCms(tx, users.super);
    await seedPlansAndIndividual(tx, password, syllabi['CBSE-10']);
  });
}

async function main() {
  const db = createDb();
  try {
    await seed(db);
    console.log(
      'Seeded demo data. Sign in as super@, admin@, teacher@, student@, parent@, cms@, webadmin@ or individual@bodhira.test with the password "password".',
    );
  } finally {
    await db.$client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
