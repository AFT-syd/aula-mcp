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
  /** Aula names this `profileId`, not `id`. */
  profileId: number;
  /** Aula names this `displayName`, not `name`. */
  displayName: string;
  portalRole?: string;
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
 * Aula's presence status codes — one enum, used by both `getDailyOverview`
 * (read) and `presence.updateStatusByInstitutionProfileIds` (write).
 *
 * Two independent sources agree on this numbering:
 *
 *  - The Python reference reads `daily_info["status"]` and indexes it into
 *    `["Ikke kommet", "Syg", "Ferie/Fri", "Kommet/Til stede", "På tur",
 *    "Sover", …, "Gået"]`, with a docstring spelling out 0/1/2/3/4/5/8
 *    (`custom_components/aula/sensor.py`).
 *  - The presence frontend bundle compiles the write path as
 *    `e[e.NOT_PRESENT=0]="NOT_PRESENT",e[e.SICK=1]="SICK",…`.
 *
 * An earlier version of this file carried a second, conflicting table that
 * claimed 1=KOMMET and 7=SYG, sourced to `binary_sensor.py` — which contains
 * no such mapping. It was wrong: a child reported sick comes back as status
 * 1, and the old table named that "arrived". Do not reintroduce a separate
 * read enum without evidence from the live API.
 */
export const PRESENCE_STATUS_CODE = {
  NOT_PRESENT: 0,
  SICK: 1,
  REPORTED_ABSENT: 2,
  PRESENT: 3,
  FIELDTRIP: 4,
  SLEEPING: 5,
  SPARE_TIME_ACTIVITY: 6,
  PHYSICAL_PLACEMENT: 7,
  CHECKED_OUT: 8,
} as const;

export type PresenceStatusCode = (typeof PRESENCE_STATUS_CODE)[keyof typeof PRESENCE_STATUS_CODE];

/**
 * Danish-facing names for the codes above, in the wording the Python
 * reference uses. 6 and 7 are the two the reference never resolved (it
 * renders them as the bare numbers), so they carry the frontend's names.
 */
export const PRESENCE_STATUS = {
  0: 'IKKE_KOMMET', // not yet at school/daycare
  1: 'SYG', // reported sick
  2: 'FERIE_FRI', // holiday / not enrolled today
  3: 'KOMMET', // arrived / present
  4: 'PAA_TUR', // on a trip
  5: 'SOVER', // sleeping
  6: 'FRITIDSAKTIVITET', // spare-time activity
  7: 'FYSISK_PLACERING', // physical placement
  8: 'GAAET', // picked up / left
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
// presence.getPresenceTemplates / presence.updatePresenceTemplate
//   — the "Komme/gå" parent registration: drop-off and pickup times.
// --------------------------------------------------------------------------

/**
 * Aula's komme/gå "henteform" — how a child leaves the institution. The
 * names are ours; the numeric values are the `activityType` enum the Aula
 * presence frontend posts (Vue bundle, presence-template module). The
 * numbers are wire constants — don't renumber them.
 */
export const PRESENCE_ACTIVITY_TYPE = {
  picked_up_by: 0, // "Hentes af" — collected by a named person
  self_decider: 1, // "Selvbestemmer" — may leave on its own within a window
  send_home: 2, // "Sendes hjem" — leaves alone at exitTime
  go_home_with: 3, // "Går hjem med" — leaves with a named person
} as const;

export type PresenceActivityType = keyof typeof PRESENCE_ACTIVITY_TYPE;

/** Repeat cadence of a presence template — Aula's `repeatPattern` strings. */
export type PresenceRepeatPattern = 'never' | 'weekly' | 'every_2_weeks';

/** Input to {@link AulaClient.updatePresenceTemplate} — one child, one day. */
export interface UpdatePresenceTemplateArgs {
  /** Child institution-profile id — the same id `getDailyOverview` takes as
   *  `childIds`, and the `institutionProfile.id` returned by
   *  `getPresenceTemplates`. */
  institutionProfileId: number;
  /** The day the template applies to, `YYYY-MM-DD`. With a repeatPattern set
   *  this is the first occurrence and fixes the weekday that repeats. */
  date: string;
  /** How the child leaves — selects which nested time block Aula expects. */
  activityType: PresenceActivityType;
  /** Drop-off time `HH:mm`. Omit if the institution has no drop-off module. */
  entryTime?: string;
  /** Pickup / go-home time `HH:mm` (picked_up_by, send_home, go_home_with). */
  exitTime?: string;
  /** Name of the person collecting the child (picked_up_by, go_home_with). */
  pickedUpBy?: string;
  /** Start of the self-decider window `HH:mm` (self_decider only). */
  selfDeciderStartTime?: string;
  /** End of the self-decider window `HH:mm` (self_decider only). */
  selfDeciderEndTime?: string;
  /** Free-text note shown to staff. */
  comment?: string;
  /** Repeat cadence. Defaults to a one-off (`never`). */
  repeatPattern?: PresenceRepeatPattern;
  /** Last date the repeat applies, `YYYY-MM-DD`. Required when repeatPattern
   *  is not `never`; ignored for a one-off. */
  repeatUntil?: string;
}

/** Input to {@link AulaClient.getPresenceTemplates}. */
export interface GetPresenceTemplatesArgs {
  /** Child institution-profile ids to fetch templates for. */
  institutionProfileIds: number[];
  /** Inclusive window start, `YYYY-MM-DD`. */
  fromDate: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  toDate: string;
}

/**
 * One day inside a returned weekly template. Aula's wire shape carries more
 * fields than this; the index signature keeps them rather than dropping them.
 */
export interface PresenceDayTemplate {
  byDate?: string;
  entryTime?: string | null;
  exitTime?: string | null;
  activityType?: number | null;
  selfDeciderStartTime?: string | null;
  selfDeciderEndTime?: string | null;
  isOnVacation?: boolean;
  [k: string]: unknown;
}

export interface PresenceWeekTemplate {
  /** The child this template belongs to. `id` is the institution-profile id
   *  to pass back to `updatePresenceTemplate`. */
  institutionProfile: { id: number; name?: string };
  dayTemplates?: PresenceDayTemplate[];
  [k: string]: unknown;
}

export interface PresenceTemplatesData {
  presenceWeekTemplates?: PresenceWeekTemplate[];
  [k: string]: unknown;
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
  /** Not exercised against the live API in this codebase before now — added
   *  for the parallel-event annotation (mcp-server's `annotateParallelEvents`),
   *  which needs something to name the "other" event by. Other Aula entity
   *  ids in this codebase are a mix of `number` (children, institutions) and
   *  `string` (message ids), so this is left loose rather than guessed at. */
  id?: number | string;
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
// posts.*
// --------------------------------------------------------------------------

export interface PostAttachmentFile {
  name?: string;
  url?: string;
  mediaType?: string;
}

export interface PostAttachment {
  name?: string;
  url?: string;
  file?: PostAttachmentFile;
}

export interface AulaPost {
  id?: number;
  title?: string;
  publishAt?: string;
  timestamp?: string;
  isImportant?: boolean;
  content?: { html?: string };
  ownerProfile?: {
    fullName?: string;
    institution?: { institutionName?: string };
  };
  attachments?: PostAttachment[];
}

export interface PostsData {
  posts?: AulaPost[];
  moreMessagesExist?: boolean;
  profileLastSeenPostDate?: string;
}

export interface GetPostsArgs {
  limit?: number;
  index?: number;
  /** Aula's own scoping parameter; `profile` is the guardian-facing feed. */
  parent?: string;
  onlyUnread?: boolean;
  /** Guardian + child institution-profile ids the feed is scoped to. */
  institutionProfileIds?: readonly number[];
}

// --------------------------------------------------------------------------
// messaging.*
// --------------------------------------------------------------------------

/** A mailbox owner as messaging returns it — the sender, a recipient, or the
 *  guardian's own mailbox. */
export interface MailBoxOwner {
  id?: number;
  profileId?: number;
  portalRole?: string;
  mailBoxOwnerType?: string;
  isDeactivated?: boolean;
}

export interface MessageThread {
  /**
   * The thread's own id — what `messaging.getMessagesForThread` takes AND what
   * `messaging.reply` takes as its `threadId`.
   */
  id: number;
  /**
   * A DIFFERENT number from `id` (measured 2026-10-10: different in all 20
   * threads sampled). NOT the reply target, despite Aula's frontend calling
   * the reply target "subscriptionId": that variable holds the thread `id`
   * (the frontend matches `e.id == shownSubscriptionId`). Measured live the
   * same day: getMessagesForThread(<listing id>) returned an object whose
   * `id` was that listing id, not the `subscriptionId`. The frontend uses
   * this field for thread bundles.
   */
  subscriptionId?: number;
  /** `unbundled` in every thread sampled; `bundle` groups several threads. */
  subscriptionType?: string;
  read: boolean;
  subject?: string;
  startedTime?: string;
  /** Who started the thread. */
  creator?: { fullName?: string; mailBoxOwner?: MailBoxOwner };
  /** Which of the guardian's own children the thread concerns. NB: `profileId`
   *  here is a different id space from the institutionProfileId that
   *  `aula.discover` returns as `children[].id`. */
  regardingChildren?: Array<{ profileId?: number; displayName?: string; shortName?: string }>;
  /**
   * Every participant, with their own read receipts (`lastReadTimestamp`).
   * Measured 2026-10-10: this field is ~half of every thread's size and
   * carries other families' data, so the MCP layer reduces it to a count.
   */
  recipients?: unknown[];
  /** Recipients beyond those listed in `recipients`. */
  extraRecipientsCount?: number;
  sensitive?: boolean;
  muted?: boolean;
  marked?: boolean;
  /** Latest message's preview, when included. */
  lastMessage?: { sendDateTime?: string; sender?: { fullName?: string } };
  /** Latest message, when included in the threads list response. Distinct
   *  from `lastMessage` (preview-only): `latestMessage.id` is what scripts
   *  need to detect "is there a new message in this thread" without
   *  fetching the full thread content via `messaging.getMessagesForThread`.
   *  Carries no sender — only the time and the HTML body. */
  latestMessage?: { id?: string; sendDateTime?: string; text?: { html?: string } };
}

export interface ThreadsData {
  threads: MessageThread[];
  /** Echo of the requested page. */
  page?: number;
  /** True when further pages exist. Aula's own name for it — see ThreadsPage
   *  for the shape callers should prefer. */
  moreMessagesExist?: boolean;
}

/**
 * One page of threads, with the pagination signal kept.
 *
 * Aula serves threads 20 at a time and **ignores `pageSize` entirely** — ask
 * for 50 and you still get 20. A caller that reads page 0 and stops therefore
 * sees a fraction of the mailbox while believing it has seen all of it, which
 * is a silent wrong answer rather than an error. Keep requesting pages while
 * `hasMorePages` is true.
 */
export interface ThreadsPage {
  threads: MessageThread[];
  page: number;
  hasMorePages: boolean;
}

/** `messaging.getThreads`' `filterOn` values, from Aula's frontend enum
 *  `{ READ: "Read", UNREAD: "Unread" }`. */
export type ThreadReadFilter = 'Read' | 'Unread';

export interface ThreadMessageAttachmentFile {
  name?: string;
  url?: string;
  mediaType?: string | null;
  size?: number | null;
}

/** One file attached to a thread message. Documents come in a `file`
 *  envelope; images (and other media) come with `file: null` and the same envelope
 *  under `media.file` instead. Either URL is a short-lived CloudFront
 *  presigned link (~1h TTL). */
export interface ThreadMessageAttachment {
  file?: ThreadMessageAttachmentFile | null;
  media?: { file?: ThreadMessageAttachmentFile | null } | null;
}

export interface ThreadMessage {
  /** Message ids are strings in the listing (`latestMessage.id`); left loose
   *  here because this shape has not been observed with an id. */
  id?: string | number;
  messageType?: string;
  text?: { html?: string; plain?: string };
  sender?: { fullName?: string; mailBoxOwner?: MailBoxOwner };
  subject?: string;
  sendDateTime?: string;
  hasAttachments?: boolean;
  attachments?: ThreadMessageAttachment[];
}

/**
 * `messaging.getMessagesForThread`' `data`. Aula's frontend stores this
 * object as the selected subscription and replies with `threadId: data.id`.
 * Measured 2026-10-10: `id` here is the thread id it was fetched with — NOT
 * the listing's `subscriptionId` (see MessageThread.subscriptionId). Only
 * `subject` and `messages` are exercised by the read tools; the rest is read
 * by the reply path, which refuses when `id` does not agree with the listing.
 */
export interface ThreadMessagesData {
  messages: ThreadMessage[];
  subject?: string;
  id?: number;
  /** Set when the guardian has left the thread. Aula's UI disables writing. */
  leaveTime?: string | null;
  sensitive?: boolean;
  /** Whose inbox the thread is in — a guardian's own, or a common/OTP inbox. */
  mailBoxOwner?: MailBoxOwner;
  recipients?: Array<{ fullName?: string; mailBoxOwner?: MailBoxOwner }>;
  extraRecipientsCount?: number;
}

// --------------------------------------------------------------------------
// groups.getGroupsByContext / profiles.getContactlist / getContactParents
// --------------------------------------------------------------------------
//
// Shapes READ in Aula's public frontend bundle (2026-10-11, re-read against
// the live responses the same day): every field is optional and the MCP layer
// passes on only an allowlist of them.

/** One group a child belongs to, as the contacts page's group menu uses it. */
export interface ContactGroup {
  id?: number;
  name?: string;
  /** The group the frontend opens by default. */
  showAsDefault?: boolean;
}

/**
 * `groups.getGroupsByContext` returns blocks, each with its `groups`. The
 * contacts page's group menu labels a block with `displayName` and keys it on
 * `profileId`.
 */
export interface ContactGroupBlock {
  groups?: ContactGroup[];
  displayName?: string;
  profileId?: number;
}

/** One person in a contact list — a child, guardian or employee. */
export interface ContactEntry {
  id?: number;
  institutionProfileId?: number;
  profileId?: number;
  fullName?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  shortName?: string;
  /** True when the name is an alias — Aula's frontend appends "(alias)" to it. */
  alias?: boolean;
  /** Portal role: `child`, `guardian`, `employee`, `otp`. */
  role?: string;
  /** For a guardian under a child: "Mor", "Far", … */
  relation?: string;
  /** Sent only to roles that may see it; the frontend shows it when non-null. */
  hasCustody?: boolean | null;
  /** Aula's frontend shows address and phone numbers only when this is true. */
  userHasGivenConsentToShowContactInformation?: boolean;
  /** A list row's details also need this; relation rows do not check it. */
  currentUserCanViewContactInformation?: boolean;
  /** `profile` or `groupHome` — a group home's home phone is not shown. */
  contactType?: string;
  email?: string | null;
  homePhoneNumber?: string | null;
  mobilePhoneNumber?: string | null;
  workPhoneNumber?: string | null;
  address?: { street?: string; postalCode?: number | string; postalDistrict?: string } | null;
  /** The people related to this one: a child's guardians, a guardian's children. */
  relations?: ContactEntry[];
}

/** `profiles.getContactlist`' `filter` values the contacts page offers a guardian. */
export type ContactListFilter = 'child' | 'guardian' | 'employee';

// --------------------------------------------------------------------------
// search.findRecipients / messaging.startNewThread
// --------------------------------------------------------------------------
//
// READ in Aula's public frontend bundle (2026-10-11), not yet observed: the
// new-message form's recipient search and its send call.

/**
 * One hit from `search.findRecipients`. For a `Profile` hit, `id` is the
 * person's institutionProfileId: the search component turns it into the
 * recipient's `id`, and drops the user's own hit by comparing it with their
 * own `institutionProfileId`s.
 */
export interface RecipientSearchResult {
  id?: number | string;
  docId?: number | string;
  /** `Profile`, `Group`, `CommonInbox`, … */
  docType?: string;
  name?: string;
  portalRole?: string;
  institutionCode?: string;
  /** Set when the municipality blocks messages between you and this profile. */
  communicationBlock?: unknown;
}

/** A `messaging.startNewThread` recipient or creator. */
export interface MailBoxOwnerRef {
  id: number;
  mailBoxOwnerType: 'institutionProfile';
}

// --------------------------------------------------------------------------
// aulaToken.getAulaToken
// --------------------------------------------------------------------------

/** Widget token responses are just strings: `{ data: "<bearer>" }`. */
export type AulaTokenResponse = string;
