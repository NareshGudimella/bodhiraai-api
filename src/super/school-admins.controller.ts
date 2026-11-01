import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../common/decorators/auth.decorators';
import { assertNotDirect } from '../common/direct-school';
import { ok } from '../common/http/api-response';
import { laravelValidate } from '../common/http/laravel-validator';
import { Role } from '../common/roles';
import { DB, type Db } from '../db/db';
import {
  SchoolAdminsService,
  schoolAdminResource,
} from './school-admins.service';
import { SuperService } from './super.service';

const NO_ADMIN = 'have a School Admin';

/** The /admin/users rules (AdminApiController::validateUser) for an admin account. */
const adminRules = (ignore?: bigint) => {
  const u = ignore ? `,${ignore}` : '';
  return {
    name: ['required', 'string', 'max:120'],
    // A School Admin signs in with the email, so it is required.
    email: ['required', 'email', 'max:160', `unique:users,email${u}`],
    phone: ['nullable', 'string', 'max:20', `unique:users,phone${u}`],
    password: [ignore ? 'nullable' : 'required', 'string', 'min:8'],
  };
};

/**
 * not in legacy: /api/v1/super/schools/:school/admins — the Super Admin
 * creates and manages a school's School Admin accounts. 404 for an unknown
 * school (or a user who isn't an admin of it), 422 `direct_school` for
 * Bodhira Direct.
 */
@Controller('super/schools/:school/admins')
@Roles(Role.SuperAdmin)
export class SchoolAdminsController {
  constructor(
    private readonly sup: SuperService,
    private readonly admins: SchoolAdminsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async list(@Param('school') raw: string) {
    const school = await this.sup.findSchool(raw);
    return ok((await this.admins.list(school)).map(schoolAdminResource));
  }

  @Post()
  async create(@Param('school') raw: string, @Body() body: unknown) {
    const school = await this.sup.findSchool(raw);
    assertNotDirect(school, NO_ADMIN);
    const data = await laravelValidate(this.db, body, adminRules());
    const u = await this.admins.create(school, data);
    return ok(schoolAdminResource(u), 'School Admin created.');
  }

  @Patch(':user')
  async update(
    @Param('school') raw: string,
    @Param('user') rawUser: string,
    @Body() body: unknown,
  ) {
    const school = await this.sup.findSchool(raw);
    assertNotDirect(school, NO_ADMIN);
    const target = await this.admins.find(school, rawUser);
    const data = await laravelValidate(this.db, body, adminRules(target.id));
    const u = await this.admins.update(target, data);
    return ok(schoolAdminResource(u), 'School Admin updated.');
  }

  @Post(':user/toggle')
  @HttpCode(200)
  async toggle(@Param('school') raw: string, @Param('user') rawUser: string) {
    const school = await this.sup.findSchool(raw);
    assertNotDirect(school, NO_ADMIN);
    const u = await this.admins.toggle(await this.admins.find(school, rawUser));
    return ok({ status: u.status }, 'School Admin status toggled.');
  }
}
