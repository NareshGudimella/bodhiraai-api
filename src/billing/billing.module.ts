import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { CheckoutController } from './checkout.controller';
import { InvoiceService } from './invoice.service';
import { SchoolBillingController } from './school-billing.controller';
import { WebhookController } from './webhook.controller';

@Module({
  controllers: [CheckoutController, SchoolBillingController, WebhookController],
  providers: [BillingService, InvoiceService],
  exports: [BillingService],
})
export class BillingModule {}
