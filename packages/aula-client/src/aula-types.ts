/**
 * Aula API response shapes — only the fields we actually consume. Names mirror
 * the JSON keys exactly so future drift is easy to spot.
 *
 * Aula's response envelope is `{ status: { code: 0, message: "OK" }, data: ... }`.
 * We unwrap `data` and surface non-zero status as an AulaApiError.
 */

/** Common envelope. */
export interface AulaEnvelope<T = unknown> {
  status?: { code: number; message?: string };
  data?: T;
  /** Some endpoints return a free-form `data` array — keep both possibilities open. */
  [k: string]: unknown;
}

// --------------------------------------------------------------------------
// profiles.getProfilesByLogin
// --------------------------------------------------------------------------

export interface AulaProfileChild {
  id: number;
  name: string;
  /** Aula returns this as either a number or an opaque string token (mix
   *  of letters and digits — looks like `"abcd1234"`); upstream Python
   *  stringifies it (`str(child["userId"])`). Treat as opaque, don't parse. */
  userId?: string | number;
  institutionProfile?: AulaInstitutionProfile;
}

export interface AulaInstitutionProfile {
  id: number;
  name?: string;
  /** Aula's institution code, e.g. "G12345". */
  institutionCode?: string;
  institutionName?: string;
  role?: string;
  shortName?: string;
  profilePicture?: { url?: string };
}

export interface AulaProfile {
  id: number;
  name: string;
  children?: AulaProfileChild[];
  institutionProfiles?: AulaInstitutionProfile[];
}

export interface ProfilesByLoginData {
  profiles: AulaProfile[];
}

// --------------------------------------------------------------------------
// profiles.getProfileContext
// --------------------------------------------------------------------------

/**
 * Aula nests the actual widget metadata under `widget`. Python reads
 * `widget["widget"]["widgetId"]` (BrowserClient.py-style helper code in the
 * scaarup reference does the same). Top-level `widgetId` was an earlier
 * shape — keep both fields optional so we tolerate either if the API
 * mutates again.
 */
export interface AulaWidgetMeta {
  widgetId: string;
  name?: string;
}

export interface AulaWidgetConfiguration {
  /** Modern (nested) shape — what production currently returns. */
  widget?: AulaWidgetMeta;
  /** Legacy / hypothetical flat shape — read as a fallback. */
  widgetId?: string;
  placement?: string;
  weight?: number;
}

export interface AulaPageConfiguration {
  widgetConfigurations?: AulaWidgetConfiguration[];
}

export interface AulaInstitutionRelation {
  institutionCode: string;
  institutionName?: string;
  /** Maps to a list of children belonging to this institution. */
  children?: AulaProfileChild[];
}

export interface AulaInstitutionProfileContext {
  id: number;
  /** Top-level relations the API surfaces for the active profile. */
  relations?: AulaInstitutionRelation[];
}

export interface ProfileContextData {
  /** Aula returns this as either a number or an opaque string token. */
  userId: string | number;
  institutionProfile?: AulaInstitutionProfileContext;
  institutionProfiles?: AulaInstitutionProfileContext[];
  pageConfiguration?: AulaPageConfiguration;
}

// --------------------------------------------------------------------------
// presence.getDailyOverview
// --------------------------------------------------------------------------

/**
 * Aula's presence status enum. Numbers come from the API; meanings are from
 * `binary_sensor.py` in the Python reference.
 */
export const PRESENCE_STATUS = {
  0: 'IKKE_KOMMET', // not yet at school/daycare
  1: 'KOMMET', // arrived
  2: 'PAA_TUR', // on a trip
  3: 'SOVER', // sleeping
  4: 'HENTET', // picked up
  5: 'FRI', // not enrolled today
  6: 'FERIE', // holiday
  7: 'SYG', // sick
  8: 'KOMMET_SELV', // arrived independently
} as const;

export type PresenceStatusName = (typeof PRESENCE_STATUS)[keyof typeof PRESENCE_STATUS];

export interface DailyOverviewEntry {
  status: number;
  location?: string;
  checkInTime?: string;
  checkOutTime?: string;
  entryTime?: string;
  exitTime?: string;
  exitWith?: string;
  comment?: string;
  activityType?: string;
  spareTimeActivity?: string;
  selfDeciderStartTime?: string;
  selfDeciderEndTime?: string;
  sleepIntervals?: Array<{ startTime?: string; endTime?: string }>;
  institutionProfile?: { id: number; profilePicture?: { url?: string } };
}

// --------------------------------------------------------------------------
// calendar.getEventsByProfileIdsAndResourceIds
// --------------------------------------------------------------------------

export interface CalendarLessonParticipant {
  teacherName?: string;
  teacherInitials?: string;
  participantRole?: string;
}

export interface CalendarEvent {
  type: 'lesson' | 'event' | string;
  title?: string;
  startDateTime: string;
  endDateTime: string;
  belongsToProfiles?: number[];
  primaryResource?: { name?: string };
  lesson?: { participants?: CalendarLessonParticipant[] };
}

export interface GetCalendarEventsArgs {
  profileIds: number[];
  resourceIds?: number[];
  /** ISO timestamp `YYYY-MM-DD HH:MM:SS.0000+TZ`. */
  start: string;
  end: string;
}

// --------------------------------------------------------------------------
// messaging.*
// --------------------------------------------------------------------------

export interface MessageThread {
  id: number;
  read: boolean;
  subject?: string;
  /** Latest message's preview, when included. */
  lastMessage?: { sendDateTime?: string; sender?: { fullName?: string } };
}

export interface ThreadsData {
  threads: MessageThread[];
}

export interface ThreadMessage {
  messageType?: string;
  text?: { html?: string; plain?: string };
  sender?: { fullName?: string };
  subject?: string;
  sendDateTime?: string;
}

export interface ThreadMessagesData {
  messages: ThreadMessage[];
  subject?: string;
}

// --------------------------------------------------------------------------
// aulaToken.getAulaToken
// --------------------------------------------------------------------------

/** Widget token responses are just strings: `{ data: "<bearer>" }`. */
export type AulaTokenResponse = string;
