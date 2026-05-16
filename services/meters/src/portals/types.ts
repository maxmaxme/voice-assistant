import type { Page } from 'playwright';
import type { AccountInfo, MeterReading } from '../storage/types.ts';

export interface PortalDeps {
  login: string;
  password: string;
  lastSubmittedValueFor(meter: string): number | null;
  today(): Date;
}

export interface Portal {
  readonly name: 'tgc1';
  fetchAccountInfo(page: Page): Promise<AccountInfo | null>;
  submit(page: Page, deps: PortalDeps): Promise<MeterReading[]>;
}
