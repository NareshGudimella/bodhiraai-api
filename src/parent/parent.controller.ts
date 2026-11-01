import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../common/decorators/auth.decorators';
import { ok } from '../common/http/api-response';
import { routeId } from '../common/http/laravel';
import { Role } from '../common/roles';
import type { users } from '../db/types';
import { ParentService } from './parent.service';

/** /api/v1/parent/* — port of Api\V1\Parent\ParentApiController. */
@Controller('parent')
@Roles(Role.Parent)
export class ParentController {
  constructor(private readonly parents: ParentService) {}

  /** Route binding (404) then the parent–child link (403). */
  private async child(parent: users, raw: string) {
    const student = await this.parents.findStudent(routeId(raw, 'User'));
    await this.parents.guardChild(parent, student);
    return student;
  }

  @Get('home')
  async home(@CurrentUser() user: users) {
    return ok(await this.parents.dashboard(user));
  }

  @Get('children')
  async children(@CurrentUser() user: users) {
    return ok(await this.parents.childrenList(user));
  }

  @Get('children/:student')
  async overview(@CurrentUser() user: users, @Param('student') raw: string) {
    return ok(await this.parents.childOverview(await this.child(user, raw)));
  }

  @Get('children/:student/attendance')
  async attendance(
    @CurrentUser() user: users,
    @Param('student') raw: string,
    @Query('month') month?: string,
  ) {
    return ok(
      await this.parents.childAttendance(await this.child(user, raw), month),
    );
  }

  @Get('children/:student/performance')
  async performance(@CurrentUser() user: users, @Param('student') raw: string) {
    return ok(await this.parents.childPerformance(await this.child(user, raw)));
  }

  @Get('children/:student/assignments')
  async assignments(@CurrentUser() user: users, @Param('student') raw: string) {
    return ok(await this.parents.childAssignments(await this.child(user, raw)));
  }
}
