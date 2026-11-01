import type { ActiveSession } from './auth/session';
import type { Env } from './env';

export interface SessionProfile {
  isStaff: boolean;
  displayName: string | null;
  plan: 'free' | 'pro' | 'studio';
  createdAt: string;
  deleted: boolean;
  /** When a scheduled account deletion runs (ISO), or null. */
  deletionDue: string | null;
}
export interface StaffContext {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'finance' | 'safety' | 'support';
  displayName: string | null;
  enrolOnly: boolean;
  accessToken: string;
  /** Signed in with a passkey in the last 10 minutes (risk-raising admin changes need it). */
  recentPasskey: boolean;
}
export type Variables = {
  requestId: string;
  session: ActiveSession;
  profile: SessionProfile;
  staff: StaffContext;
  accessEmail: string;
};
export type HonoEnv = { Bindings: Env; Variables: Variables };
