import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDb, DB, type Db } from './db';

@Global()
@Module({
  providers: [{ provide: DB, useFactory: () => createDb() }],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown() {
    await this.db.$client.end();
  }
}
