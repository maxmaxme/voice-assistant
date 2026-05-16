import type { AccountInfo, MeterReading } from '../storage/types.ts';

export interface PortalDeps {
  login: string;
  password: string;
  lastSubmittedValueFor(meter: string): number | null;
  today(): Date;
}

export interface Portal {
  readonly name: 'tgc1' | 'pesc';
  /**
   * Logs in, fetches account balance and the device list, submits readings
   * for every counter where it's accepted, verifies that `dtLastReading`
   * advanced to today, and returns both the account info and the list of
   * readings actually submitted. Throws on any unrecoverable failure;
   * partial success also throws.
   */
  run(deps: PortalDeps): Promise<{
    info: AccountInfo | null;
    values: MeterReading[];
    /** True when no new reading was POSTed — every counter was already submitted earlier today. */
    alreadySubmitted: boolean;
  }>;
}
