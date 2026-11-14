import type { ActiveSession } from './auth/session';
import type { Env } from './env';
import type { LibraryContext } from './library/context';

export interface SessionProfile {
  isStaff: boolean;
  displayName: string | null;
  plan: 'free' | 'pro' | 'studio';
  createdAt: string;
  deleted: boolean;
  /** When a scheduled account deletion runs (ISO), or null. */
  deletionDue: string | null;
  /** Phase 8: staff suspended the account. Optional: when absent, `member_suspended` is asked. */
  suspended?: boolean;
  /** Phase 8: the last retention batch of the member's own library within 30 days, or null. */
  retention?: { trashedAt: string; photos: number; restoreBy: string } | null;
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
  /** Phase 7: the library a library-scoped request acts on (libraryContext). */
  library: LibraryContext;
};
export type HonoEnv = { Bindings: Env; Variables: Variables };
